import type {
  BikeRouteResponse,
  RouteEndpoint,
} from "@workspace/api-zod";
import { findMappedBikewayPath, type BikeCoordinate } from "./bikeway-graph";
import { getBikeNetwork } from "./lanesight-service";

const CITY_BOUNDS = {
  south: 37.707,
  west: -122.516,
  north: 37.833,
  east: -122.355,
};
const APP_USER_AGENT = "LaneSight/1.0 (San Francisco bicycle route planner)";
const CONNECTOR_PROFILE = "fastbike-verylowtraffic";
const MAX_CONNECTOR_ROUTE_METERS = 2_500;
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

function distanceMeters(a: BikeCoordinate, b: BikeCoordinate): number {
  const earthRadiusMeters = 6_371_000;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = ((b[0] - a[0]) * Math.PI) / 180;
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
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

export class NoMappedBikewayRouteError extends Error {
  constructor() {
    super(
      "No continuous, direction-aware route on the mapped SFMTA bike-lane network connects these places. Try nearby starting points.",
    );
    this.name = "NoMappedBikewayRouteError";
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
      throw new Error(`The place search service returned HTTP ${response.status}.`);
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

async function routeStreetConnector(
  from: BikeCoordinate,
  to: BikeCoordinate,
): Promise<RoutedLine> {
  if (distanceMeters(from, to) < 2) {
    return { coordinates: [from, to], distanceMeters: 0, durationSeconds: 0 };
  }

  const url = new URL("https://brouter.de/brouter");
  url.searchParams.set("lonlats", `${from[0]},${from[1]}|${to[0]},${to[1]}`);
  url.searchParams.set("profile", CONNECTOR_PROFILE);
  url.searchParams.set("alternativeidx", "0");
  url.searchParams.set("format", "geojson");

  const response = await fetch(url, {
    headers: {
      Accept: "application/geo+json",
      "User-Agent": APP_USER_AGENT,
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    throw new Error(`The bicycle connector service returned HTTP ${response.status}.`);
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
    throw new Error("The bicycle connector service returned no usable street route.");
  }
  return { coordinates, distanceMeters: distance, durationSeconds: duration };
}

function combineCoordinates(parts: BikeCoordinate[][]): BikeCoordinate[] {
  const combined: BikeCoordinate[] = [];
  for (const part of parts) {
    for (const point of part) {
      const previous = combined[combined.length - 1];
      if (!previous || distanceMeters(previous, point) >= 1) combined.push(point);
    }
  }
  return combined;
}

export async function planBikeRoute(
  originText: string,
  destinationText: string,
): Promise<BikeRouteResponse> {
  const origin = await resolvePlace(originText);
  const destination = await resolvePlace(destinationText);
  const network = await getBikeNetwork();
  const lanePath = findMappedBikewayPath(
    network,
    [origin.longitude, origin.latitude],
    [destination.longitude, destination.latitude],
  );
  if (!lanePath) throw new NoMappedBikewayRouteError();

  const start: BikeCoordinate = [
    lanePath.startCoordinate[0],
    lanePath.startCoordinate[1],
  ];
  const end: BikeCoordinate = [
    lanePath.endCoordinate[0],
    lanePath.endCoordinate[1],
  ];
  const [startConnector, endConnector] = await Promise.all([
    routeStreetConnector([origin.longitude, origin.latitude], start),
    routeStreetConnector(end, [destination.longitude, destination.latitude]),
  ]);

  if (
    startConnector.distanceMeters > MAX_CONNECTOR_ROUTE_METERS ||
    endConnector.distanceMeters > MAX_CONNECTOR_ROUTE_METERS
  ) {
    throw new NoMappedBikewayRouteError();
  }

  const connectorCoordinates = [
    startConnector.coordinates,
    endConnector.coordinates,
  ];
  const coordinates = combineCoordinates([
    startConnector.coordinates,
    lanePath.laneCoordinates,
    endConnector.coordinates,
  ]);
  const connectorDistanceMeters =
    startConnector.distanceMeters + endConnector.distanceMeters;
  const distance = connectorDistanceMeters + lanePath.laneDistanceMeters;
  const duration =
    startConnector.durationSeconds +
    endConnector.durationSeconds +
    lanePath.laneDistanceMeters / 4;

  return {
    origin,
    destination,
    distanceMeters: distance,
    durationSeconds: duration,
    profile: "SFMTA Class I/II/IV bikeways with low-traffic OSM connectors",
    source: "SFMTA Bike Network + OpenStreetMap via BRouter",
    laneDistanceMeters: lanePath.laneDistanceMeters,
    connectorDistanceMeters,
    networkUpdatedAt: network.sourceUpdatedAt,
    laneCoordinates: lanePath.laneCoordinates,
    connectorCoordinates,
    coordinates,
  };
}
