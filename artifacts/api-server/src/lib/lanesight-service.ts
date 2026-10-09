import {
  type BikeLaneSegment,
  type BikeNetworkResponse,
  type BikeRouteResponse,
  type BikeStation,
  type BikeStationsResponse,
  type StreetClosure,
  type StreetConditionsResponse,
  type StreetReport,
} from "@workspace/api-zod";

const CITY_BOUNDS = {
  south: 37.707,
  west: -122.516,
  north: 37.833,
  east: -122.355,
};

const ROUTING_PROFILE = "fastbike-verylowtraffic";
const APP_USER_AGENT = "LaneSight/1.0 (San Francisco bicycle route planner)";
const cache = new Map<string, { expiresAt: number; value: unknown }>();
const geocodeCache = new Map<
  string,
  { expiresAt: number; value: { label: string; latitude: number; longitude: number } }
>();
let geocodeQueue: Promise<void> = Promise.resolve();
let lastGeocodeRequestAt = 0;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "YES";
}

function lineString(value: unknown): BikeLaneSegment["geometry"] | null {
  const geometry = record(value);
  if (geometry.type !== "LineString" || !Array.isArray(geometry.coordinates)) {
    return null;
  }

  const coordinates = geometry.coordinates.filter(
    (coordinate): coordinate is number[] =>
      Array.isArray(coordinate) &&
      coordinate.length >= 2 &&
      Number.isFinite(Number(coordinate[0])) &&
      Number.isFinite(Number(coordinate[1])),
  );

  if (coordinates.length < 2) return null;
  return { type: "LineString", coordinates };
}

function isoFromEpoch(value: unknown): string | null {
  const epoch = number(value, Number.NaN);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch * 1000).toISOString();
}

function isoOrNow(value: unknown): string {
  const raw = text(value);
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function withinCity(latitude: number, longitude: number): boolean {
  return (
    latitude >= CITY_BOUNDS.south &&
    latitude <= CITY_BOUNDS.north &&
    longitude >= CITY_BOUNDS.west &&
    longitude <= CITY_BOUNDS.east
  );
}

async function fetchJson(url: URL | string, accept = "application/json"): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": APP_USER_AGENT,
    },
    signal: AbortSignal.timeout(25_000),
  });

  if (!response.ok) {
    throw new Error(`Upstream returned HTTP ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value as T;

  const value = await load();
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

function maxTimestamp(values: string[]): string | null {
  const timestamps = values.filter((value) => !Number.isNaN(Date.parse(value)));
  if (timestamps.length === 0) return null;
  return timestamps.reduce((latest, current) =>
    Date.parse(current) > Date.parse(latest) ? current : latest,
  );
}

export async function getBikeNetwork(): Promise<BikeNetworkResponse> {
  return cached("bike-network", 6 * 60 * 60 * 1000, async () => {
    const url = new URL("https://data.sf.gov/resource/ygmz-vaxd.geojson");
    url.searchParams.set("$limit", "6000");
    url.searchParams.set(
      "$select",
      "objectid,streetname,facility_t,symbology,from_st,to_st,sharrow,buffered,raised,contraflow,data_as_of,data_loaded_at,shape",
    );

    const collection = record(await fetchJson(url, "application/geo+json"));
    const features = Array.isArray(collection.features) ? collection.features : [];
    const segments: BikeLaneSegment[] = [];

    for (const feature of features) {
      const item = record(feature);
      const properties = record(item.properties);
      const geometry = lineString(item.geometry);
      if (!geometry) continue;

      segments.push({
        id: text(properties.objectid, `segment-${segments.length}`),
        streetName: text(properties.streetname, "Unnamed street"),
        facilityType: text(properties.facility_t, "Unclassified"),
        symbology: text(properties.symbology, "BIKE ROUTE"),
        fromStreet: typeof properties.from_st === "string" ? properties.from_st : null,
        toStreet: typeof properties.to_st === "string" ? properties.to_st : null,
        sharrow: flag(properties.sharrow),
        buffered: flag(properties.buffered),
        raised: flag(properties.raised),
        contraflow: flag(properties.contraflow),
        dataAsOf: typeof properties.data_as_of === "string" ? properties.data_as_of : null,
        geometry,
      });
    }

    if (segments.length === 0) {
      throw new Error("The city bikeway feed returned no usable line features.");
    }

    const sourceUpdatedAt =
      maxTimestamp(segments.flatMap((segment) => (segment.dataAsOf ? [segment.dataAsOf] : []))) ??
      new Date().toISOString();

    return {
      sourceUpdatedAt,
      total: segments.length,
      segments,
    };
  });
}

interface GbfsFeed {
  last_updated?: number;
  ttl?: number;
  data?: { stations?: unknown[] };
}

export async function getBikeStations(): Promise<BikeStationsResponse> {
  return cached("bike-stations", 30_000, async () => {
    const [informationUnknown, statusUnknown] = await Promise.all([
      fetchJson("https://gbfs.lyft.com/gbfs/1.1/bay/en/station_information.json"),
      fetchJson("https://gbfs.lyft.com/gbfs/1.1/bay/en/station_status.json"),
    ]);
    const information = informationUnknown as GbfsFeed;
    const status = statusUnknown as GbfsFeed;
    const stationInfo = information.data?.stations ?? [];
    const stationStatus = status.data?.stations ?? [];
    const statusById = new Map(
      stationStatus.map((item) => {
        const station = record(item);
        return [text(station.station_id), station] as const;
      }),
    );

    const stations: BikeStation[] = [];
    for (const item of stationInfo) {
      const info = record(item);
      const id = text(info.station_id);
      const stationStatusRow = statusById.get(id);
      if (!id || !stationStatusRow || !flag(stationStatusRow.is_installed)) continue;

      const latitude = number(info.lat, Number.NaN);
      const longitude = number(info.lon, Number.NaN);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      if (!withinCity(latitude, longitude)) continue;

      stations.push({
        id,
        name: text(info.name, "Bay Wheels station"),
        shortName: typeof info.short_name === "string" ? info.short_name : null,
        latitude,
        longitude,
        bikesAvailable: Math.max(0, Math.trunc(number(stationStatusRow.num_bikes_available))),
        ebikesAvailable: Math.max(
          0,
          Math.trunc(number(stationStatusRow.num_ebikes_available)),
        ),
        docksAvailable: Math.max(0, Math.trunc(number(stationStatusRow.num_docks_available))),
        capacity:
          info.capacity === undefined || info.capacity === null
            ? null
            : Math.max(0, Math.trunc(number(info.capacity))),
        isRenting: flag(stationStatusRow.is_renting),
        isReturning: flag(stationStatusRow.is_returning),
        lastReported:
          isoFromEpoch(stationStatusRow.last_reported) ??
          isoFromEpoch(status.last_updated) ??
          new Date().toISOString(),
      });
    }

    if (stations.length === 0) {
      throw new Error("The Bay Wheels feed returned no active San Francisco stations.");
    }

    return {
      fetchedAt: new Date().toISOString(),
      updatedAt: isoFromEpoch(status.last_updated) ?? new Date().toISOString(),
      ttlSeconds: Math.max(1, Math.trunc(number(status.ttl, 60))),
      stations,
    };
  });
}

function soqlTimestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "");
}

function toStreetClosure(row: unknown): StreetClosure | null {
  const item = record(row);
  const geometry = lineString(item.shape);
  if (!geometry) return null;

  const street = text(item.street, "Street restriction");
  return {
    id: text(item.objectid),
    name: text(item.case_name, street),
    type: text(item.type, "Street permit"),
    status: text(item.status, "Permitted"),
    startAt: isoOrNow(item.start_utc),
    endAt: isoOrNow(item.end_utc),
    street,
    fromStreet: typeof item.from_st === "string" ? item.from_st : null,
    toStreet: typeof item.to_st === "string" ? item.to_st : null,
    locationDescription: text(item.loc_desc, street),
    laneImpact: text(item.veh_imp, "Impact not specified"),
    geometry,
  };
}

function reportDetail(value: unknown): string {
  return text(value, "Pavement or obstruction report")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toStreetReport(row: unknown): StreetReport | null {
  const item = record(row);
  const point = record(item.point_geom);
  const coordinates = Array.isArray(point.coordinates) ? point.coordinates : [];
  const longitude = number(coordinates[0], Number.NaN);
  const latitude = number(coordinates[1], Number.NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const isDefect = text(item.service_name) === "Street Defect";
  return {
    id: text(item.service_request_id),
    category: isDefect ? "Pavement defect report" : "Reported obstruction",
    detail: reportDetail(item.service_details ?? item.service_subtype),
    address: text(item.address, "Address not provided"),
    status: text(item.status_description, "Open"),
    reportedAt: isoOrNow(item.requested_datetime),
    latitude,
    longitude,
  };
}

export async function getStreetConditions(): Promise<StreetConditionsResponse> {
  return cached("street-conditions", 60_000, async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const closuresUrl = new URL("https://data.sf.gov/resource/8x25-yybr.json");
    closuresUrl.searchParams.set(
      "$select",
      "objectid,case_name,type,status,start_utc,end_utc,street,from_st,to_st,loc_desc,veh_imp,shape",
    );
    closuresUrl.searchParams.set(
      "$where",
      `status = 'Permitted' AND start_utc <= '${soqlTimestamp(future)}' AND end_utc >= '${soqlTimestamp(now)}' AND within_box(shape, ${CITY_BOUNDS.south}, ${CITY_BOUNDS.west}, ${CITY_BOUNDS.north}, ${CITY_BOUNDS.east})`,
    );
    closuresUrl.searchParams.set("$order", "start_utc");
    closuresUrl.searchParams.set("$limit", "300");

    const reportsUrl = new URL("https://data.sf.gov/resource/vw6y-z8j6.json");
    reportsUrl.searchParams.set(
      "$select",
      "service_request_id,service_name,service_subtype,service_details,requested_datetime,status_description,address,point_geom",
    );
    reportsUrl.searchParams.set(
      "$where",
      `requested_datetime >= '${soqlTimestamp(since)}' AND status_description = 'Open' AND within_box(point_geom, ${CITY_BOUNDS.south}, ${CITY_BOUNDS.west}, ${CITY_BOUNDS.north}, ${CITY_BOUNDS.east}) AND ((service_name = 'Street Defect' AND service_subtype = 'pavement_defect') OR (service_name = 'Blocked Street and Sidewalk' AND (service_details = 'construction_equipment' OR service_details = 'construction_materials' OR service_details = 'a_frame_construction' OR service_details = 'other_scooter_bike')))`,
    );
    reportsUrl.searchParams.set("$order", "requested_datetime DESC");
    reportsUrl.searchParams.set("$limit", "300");

    const [closuresUnknown, reportsUnknown] = await Promise.all([
      fetchJson(closuresUrl),
      fetchJson(reportsUrl),
    ]);
    const closureRows = Array.isArray(closuresUnknown) ? closuresUnknown : [];
    const reportRows = Array.isArray(reportsUnknown) ? reportsUnknown : [];
    const closures = closureRows
      .map(toStreetClosure)
      .filter((item): item is StreetClosure => item !== null);
    const reports = reportRows
      .map(toStreetReport)
      .filter((item): item is StreetReport => item !== null);

    return {
      fetchedAt: new Date().toISOString(),
      closures,
      reports,
    };
  });
}

export class PlaceNotFoundError extends Error {
  constructor(place: string) {
    super(`Could not find “${place}” within San Francisco.`);
    this.name = "PlaceNotFoundError";
  }
}

interface ResolvedPlace {
  label: string;
  latitude: number;
  longitude: number;
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

async function resolvePlace(input: string): Promise<ResolvedPlace> {
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
    const latitude = number(match?.lat, Number.NaN);
    const longitude = number(match?.lon, Number.NaN);
    if (!match || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new PlaceNotFoundError(place);
    }
    if (!withinCity(latitude, longitude)) {
      throw new PlaceNotFoundError(place);
    }

    const value = {
      label: text(match.display_name, place),
      latitude,
      longitude,
    };
    geocodeCache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, value });
    return value;
  });
}

export async function planBikeRoute(
  originText: string,
  destinationText: string,
): Promise<BikeRouteResponse> {
  const origin = await resolvePlace(originText);
  const destination = await resolvePlace(destinationText);
  const url = new URL("https://brouter.de/brouter");
  url.searchParams.set(
    "lonlats",
    `${origin.longitude},${origin.latitude}|${destination.longitude},${destination.latitude}`,
  );
  url.searchParams.set("profile", ROUTING_PROFILE);
  url.searchParams.set("alternativeidx", "0");
  url.searchParams.set("format", "geojson");

  const result = record(await fetchJson(url, "application/geo+json"));
  const features = Array.isArray(result.features) ? result.features : [];
  const feature = record(features[0]);
  const properties = record(feature.properties);
  const geometry = lineString(feature.geometry);
  const distanceMeters = number(properties["track-length"], Number.NaN);
  const durationSeconds = number(properties["total-time"], Number.NaN);
  if (!geometry || !Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
    throw new Error("The bicycle router returned no usable route.");
  }

  return {
    origin,
    destination,
    distanceMeters,
    durationSeconds,
    profile: ROUTING_PROFILE,
    source: "OpenStreetMap via BRouter",
    coordinates: geometry.coordinates,
  };
}
