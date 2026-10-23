import {
  type BikeLaneSegment,
  type BikeNetworkResponse,
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

const APP_USER_AGENT = "LaneSight/1.0 (San Francisco bicycle route planner)";
const cache = new Map<string, { expiresAt: number; value: unknown }>();

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

function parseIso(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
      "objectid,streetname,facility_t,symbology,from_st,to_st,sharrow,buffered,raised,contraflow,dir,direct,data_as_of,data_loaded_at,shape",
    );

    const collection = record(await fetchJson(url, "application/geo+json"));
    const features = Array.isArray(collection.features) ? collection.features : [];
    const segments: BikeLaneSegment[] = [];
    const loadedAtValues: string[] = [];

    for (const feature of features) {
      const item = record(feature);
      const properties = record(item.properties);
      const geometry = lineString(item.geometry);
      if (!geometry) continue;
      if (typeof properties.data_loaded_at === "string") {
        loadedAtValues.push(properties.data_loaded_at);
      }

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
        direction: typeof properties.dir === "string" ? properties.dir : null,
        direct: typeof properties.direct === "string" ? properties.direct : null,
        dataAsOf: typeof properties.data_as_of === "string" ? properties.data_as_of : null,
        geometry,
      });
    }

    if (segments.length === 0) {
      throw new Error("The city bikeway feed returned no usable line features.");
    }

    const sourceUpdatedAt = maxTimestamp(loadedAtValues);
    if (!sourceUpdatedAt) {
      throw new Error("The city bikeway feed did not include an as-of date.");
    }

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

      const bikesAvailable = Number(stationStatusRow.num_bikes_available);
      const ebikesAvailable = Number(stationStatusRow.num_ebikes_available);
      const docksAvailable = Number(stationStatusRow.num_docks_available);
      if (
        !Number.isFinite(bikesAvailable) ||
        !Number.isFinite(ebikesAvailable) ||
        !Number.isFinite(docksAvailable)
      ) {
        continue;
      }

      stations.push({
        id,
        name: text(info.name, "Bay Wheels station"),
        shortName: typeof info.short_name === "string" ? info.short_name : null,
        latitude,
        longitude,
        bikesAvailable: Math.max(0, Math.trunc(bikesAvailable)),
        ebikesAvailable: Math.max(0, Math.trunc(ebikesAvailable)),
        docksAvailable: Math.max(0, Math.trunc(docksAvailable)),
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

    const updatedAt = isoFromEpoch(status.last_updated);
    if (!updatedAt) {
      throw new Error("The Bay Wheels status feed did not include an update timestamp.");
    }

    return {
      fetchedAt: new Date().toISOString(),
      updatedAt,
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
  const id = text(item.objectid);
  const startAt = parseIso(item.start_utc);
  const endAt = parseIso(item.end_utc);
  const street = text(item.street);
  if (!geometry || !id || !startAt || !endAt || !street) return null;

  return {
    id,
    name: text(item.case_name, street),
    type: text(item.type, "Street permit"),
    status: text(item.status, "Permitted"),
    startAt,
    endAt,
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
  const id = text(item.service_request_id);
  const reportedAt = parseIso(item.requested_datetime);
  if (!id || !reportedAt || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const isDefect = text(item.service_name) === "Street Defect";
  return {
    id,
    category: isDefect ? "Pavement defect report" : "Reported obstruction",
    detail: reportDetail(item.service_details ?? item.service_subtype),
    address: text(item.address, "Address not provided"),
    status: text(item.status_description, "Open"),
    reportedAt,
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

