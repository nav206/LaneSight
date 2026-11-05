import type {
  BikeRouteResponse,
  PlanBikeRouteResult,
  RouteEndpoint,
} from "@workspace/api-zod";
import type { BikeCoordinate } from "./bikeway-graph";
import { getBikeNetwork } from "./lanesight-service";
import {
  attributeRouteToSfmta,
  jaccardOverlap,
} from "./sfmta-attribute";

const CITY_BOUNDS = {
  south: 37.707,
  west: -122.516,
  north: 37.833,
  east: -122.355,
};
const APP_USER_AGENT = "LaneSight/1.0 (San Francisco bicycle route planner)";
const ROUTE_PROFILE = "fastbike-verylowtraffic";
const geocodeCache = new Map<
  string,
  { expiresAt: number; value: RouteEndpoint }
>();
let geocodeQueue: Promise<void> = Promise.resolve();
let lastGeocodeRequestAt = 0;

type JsonRecord = Record<string, unknown>;

interface RoutedLine {
  coordinates: BikeCoordinate[];
  distanceMeters: number;
  durationSeconds: number;
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function lineCoordinates(value: unknown): BikeCoordinate[] | null {
  const geometry = record(value);
  if (geometry.type !== "LineString" || !Array.isArray(geometry.coordinates)) {
    return null;
  }
  const coordinates: BikeCoordinate[] = [];
  for (const item of geometry.coordinates) {
    if (!Array.isArray(item)) continue;
    const longitude = number(item[0]);
    const latitude = number(item[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    coordinates.push([longitude, latitude]);
  }
  return coordinates.length >= 2 ? coordinates : null;
}

function withinCity(latitude: number, longitude: number): boolean {
  return (
    latitude >= CITY_BOUNDS.south &&
    latitude <= CITY_BOUNDS.north &&
    longitude >= CITY_BOUNDS.west &&
    longitude <= CITY_BOUNDS.east
  );
}

export class PlaceNotFoundError extends Error {
  constructor(place: string) {
    super(`Could not find “${place}” within San Francisco.`);
    this.name = "PlaceNotFoundError";
  }
}

/** @deprecated kept for route error mapping during transition */
export class NoMappedBikewayRouteError extends Error {
  constructor() {
    super(
      "No continuous, direction-aware route on the mapped SFMTA bike-lane network connects these places. Try nearby starting points.",
    );
    this.name = "NoMappedBikewayRouteError";
  }
}

export class BikeRoutingUnavailableError extends Error {
  constructor(message = "Route planning is temporarily unavailable. Please try again.") {
    super(message);
    this.name = "BikeRoutingUnavailableError";
  }
}

async function withGeocoderLimit<T>(operation: () => Promise<T>): Promise<T> {
  const previous = geocodeQueue;
  let release: () => void = () => undefined;
  geocodeQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const waitMs = Math.max(0, 1_100 - (Date.now() - lastGeocodeRequestAt));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastGeocodeRequestAt = Date.now();
    return await operation();
  } finally {
    release();
  }
}

async function resolvePlace(input: string): Promise<RouteEndpoint> {
  const place = input.trim();
  const key = place.toLocaleLowerCase();
  const saved = geocodeCache.get(key);
  if (saved && saved.expiresAt > Date.now()) return saved.value;

  return withGeocoderLimit(async () => {
    const recent = geocodeCache.get(key);
    if (recent && recent.expiresAt > Date.now()) return recent.value;

    const searchQuery = /san francisco/i.test(place)
      ? place
      : `${place}, San Francisco, CA`;
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("q", searchQuery);
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "us");
    url.searchParams.set(
      "viewbox",
      `${CITY_BOUNDS.west},${CITY_BOUNDS.north},${CITY_BOUNDS.east},${CITY_BOUNDS.south}`,
    );
    url.searchParams.set("bounded", "1");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": APP_USER_AGENT,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new BikeRoutingUnavailableError(
        `The place search service returned HTTP ${response.status}.`,
      );
    }

    const matches = (await response.json()) as Array<{
      lat?: string;
      lon?: string;
      display_name?: string;
    }>;
    const match = matches[0];
    const latitude = number(match?.lat);
    const longitude = number(match?.lon);
    if (!match || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new PlaceNotFoundError(place);
    }
    if (!withinCity(latitude, longitude)) throw new PlaceNotFoundError(place);

    const value: RouteEndpoint = {
      label: text(match.display_name) || place,
      latitude,
      longitude,
    };
    geocodeCache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, value });
    return value;
  });
}

async function routeWithBRouter(
  from: BikeCoordinate,
  to: BikeCoordinate,
  alternativeIndex: number,
): Promise<RoutedLine> {
  const url = new URL("https://brouter.de/brouter");
  url.searchParams.set("lonlats", `${from[0]},${from[1]}|${to[0]},${to[1]}`);
  url.searchParams.set("profile", ROUTE_PROFILE);
  url.searchParams.set("alternativeidx", String(alternativeIndex));
  url.searchParams.set("format", "geojson");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/geo+json",
        "User-Agent": APP_USER_AGENT,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new BikeRoutingUnavailableError();
  }
  if (!response.ok) {
    throw new BikeRoutingUnavailableError(
      `The bicycle routing service returned HTTP ${response.status}.`,
    );
  }

  const featureCollection = record(await response.json());
  const features = Array.isArray(featureCollection.features)
    ? featureCollection.features
    : [];
  const feature = record(features[0]);
  const properties = record(feature.properties);
  const coordinates = lineCoordinates(feature.geometry);
  const distance = number(properties["track-length"]);
  const duration = number(properties["total-time"]);
  if (
    !coordinates ||
    !Number.isFinite(distance) ||
    !Number.isFinite(duration) ||
    distance < 0 ||
    duration < 0
  ) {
    throw new BikeRoutingUnavailableError(
      "The bicycle routing service returned no usable route.",
    );
  }
  return { coordinates, distanceMeters: distance, durationSeconds: duration };
}

function toBikeRouteResponse(
  origin: RouteEndpoint,
  destination: RouteEndpoint,
  routed: RoutedLine,
  attribution: ReturnType<typeof attributeRouteToSfmta>,
  label: string,
  networkUpdatedAt: string,
): BikeRouteResponse {
  return {
    origin,
    destination,
    label,
    distanceMeters: routed.distanceMeters,
    durationSeconds: routed.durationSeconds,
    designatedPercent: attribution.designatedPercent,
    mixedTrafficMeters: attribution.mixedTrafficMeters,
    transitionCount: attribution.transitions.length,
    profile: "BRouter low-traffic bike + SFMTA facility attribution",
    source: "OpenStreetMap via BRouter · SFMTA Bike Network",
    laneDistanceMeters: attribution.laneDistanceMeters,
    connectorDistanceMeters: attribution.connectorDistanceMeters,
    networkUpdatedAt,
    laneCoordinates: attribution.laneCoordinates,
    connectorCoordinates: attribution.connectorCoordinates,
    coordinates: attribution.coordinates,
    segments: attribution.segments.map((segment) => ({
      coordinates: segment.coordinates,
      distanceMeters: segment.distanceMeters,
      facility: segment.facility,
      designated: segment.designated,
      source: segment.source,
    })),
    transitions: attribution.transitions,
  };
}

function areDistinct(a: BikeRouteResponse, b: BikeRouteResponse): boolean {
  const overlap = jaccardOverlap(
    a.coordinates as BikeCoordinate[],
    b.coordinates as BikeCoordinate[],
  );
  const percentDelta = Math.abs(a.designatedPercent - b.designatedPercent);
  const durationDelta = Math.abs(a.durationSeconds - b.durationSeconds);
  return overlap < 0.85 || percentDelta >= 5 || durationDelta >= 120;
}

function orderRoutes(
  candidates: BikeRouteResponse[],
): { selectedIndex: number; routes: BikeRouteResponse[] } {
  if (candidates.length === 0) {
    throw new BikeRoutingUnavailableError();
  }
  if (candidates.length === 1 || !areDistinct(candidates[0], candidates[1])) {
    const only = { ...candidates[0], label: "Route" };
    return { selectedIndex: 0, routes: [only] };
  }

  const [first, second] = candidates;
  const byDesignated = [...candidates].sort((a, b) => {
    if (b.designatedPercent !== a.designatedPercent) {
      return b.designatedPercent - a.designatedPercent;
    }
    return b.durationSeconds - a.durationSeconds;
  });

  if (first.designatedPercent === second.designatedPercent) {
    const durationDelta = Math.abs(first.durationSeconds - second.durationSeconds);
    if (durationDelta < 120) {
      return { selectedIndex: 0, routes: [{ ...byDesignated[0], label: "Route" }] };
    }
    const longer =
      first.durationSeconds >= second.durationSeconds ? first : second;
    const shorter =
      first.durationSeconds < second.durationSeconds ? first : second;
    return {
      selectedIndex: 0,
      routes: [
        { ...longer, label: "More lanes" },
        { ...shorter, label: "Faster" },
      ],
    };
  }

  const moreLanes = byDesignated[0];
  const faster = [...candidates].sort(
    (a, b) => a.durationSeconds - b.durationSeconds,
  )[0];
  if (moreLanes === faster || moreLanes.coordinates === faster.coordinates) {
    const other = candidates.find((route) => route !== moreLanes) ?? candidates[1];
    return {
      selectedIndex: 0,
      routes: [
        { ...moreLanes, label: "More lanes" },
        { ...other, label: "Faster" },
      ],
    };
  }
  return {
    selectedIndex: 0,
    routes: [
      { ...moreLanes, label: "More lanes" },
      { ...faster, label: "Faster" },
    ],
  };
}

export async function planBikeRoute(
  originText: string,
  destinationText: string,
): Promise<PlanBikeRouteResult> {
  const origin = await resolvePlace(originText);
  const destination = await resolvePlace(destinationText);
  const network = await getBikeNetwork();
  const from: BikeCoordinate = [origin.longitude, origin.latitude];
  const to: BikeCoordinate = [destination.longitude, destination.latitude];

  const primary = await routeWithBRouter(from, to, 0);
  let secondary: RoutedLine | null = null;
  try {
    secondary = await routeWithBRouter(from, to, 1);
  } catch {
    secondary = null;
  }

  const attributedPrimary = attributeRouteToSfmta(primary.coordinates, network);
  const candidates: BikeRouteResponse[] = [
    toBikeRouteResponse(
      origin,
      destination,
      primary,
      attributedPrimary,
      "Route",
      network.sourceUpdatedAt,
    ),
  ];

  if (secondary) {
    const attributedSecondary = attributeRouteToSfmta(
      secondary.coordinates,
      network,
    );
    candidates.push(
      toBikeRouteResponse(
        origin,
        destination,
        secondary,
        attributedSecondary,
        "Route",
        network.sourceUpdatedAt,
      ),
    );
  }

  return orderRoutes(candidates);
}
