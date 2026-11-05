import type { BikeLaneSegment, BikeNetworkResponse } from "@workspace/api-zod";
import type { BikeCoordinate } from "./bikeway-graph";

export type RouteFacility = "protected" | "bike_lane" | "shared" | "ordinary";
export type RouteSegmentSource = "sfmta" | "unmatched";

export interface AttributedSegment {
  coordinates: BikeCoordinate[];
  distanceMeters: number;
  facility: RouteFacility;
  designated: boolean;
  source: RouteSegmentSource;
}

export interface RouteTransition {
  latitude: number;
  longitude: number;
  fromFacility: RouteFacility;
  toFacility: RouteFacility;
  warning: string;
}

export interface AttributionResult {
  segments: AttributedSegment[];
  transitions: RouteTransition[];
  designatedPercent: number;
  mixedTrafficMeters: number;
  laneDistanceMeters: number;
  connectorDistanceMeters: number;
  laneCoordinates: BikeCoordinate[];
  connectorCoordinates: BikeCoordinate[][];
  coordinates: BikeCoordinate[];
}

const MAX_LATERAL_METERS = 25;
const SPLIT_GAP_METERS = 15;

interface IndexedFeature {
  segment: BikeLaneSegment;
  facility: RouteFacility;
  designated: boolean;
  mid: BikeCoordinate;
  bearing: number | null;
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

function bearingDegrees(a: BikeCoordinate, b: BikeCoordinate): number {
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const deltaLon = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function compassToBearing(direction: string | null | undefined): number | null {
  if (!direction) return null;
  const key = direction.trim().toUpperCase();
  const map: Record<string, number> = {
    N: 0,
    NE: 45,
    E: 90,
    SE: 135,
    S: 180,
    SW: 225,
    W: 270,
    NW: 315,
  };
  return map[key] ?? null;
}

function bearingsCompatible(
  travel: number,
  facilityBearing: number | null,
  direct: string | null | undefined,
): boolean {
  if (facilityBearing === null) return true;
  const isTwoWay = (direct ?? "").toUpperCase().includes("2");
  const delta = Math.abs(((travel - facilityBearing + 540) % 360) - 180);
  if (delta <= 55) return true;
  if (isTwoWay) {
    const reverse = (facilityBearing + 180) % 360;
    const reverseDelta = Math.abs(((travel - reverse + 540) % 360) - 180);
    return reverseDelta <= 55;
  }
  return false;
}

export function mapFacility(segment: BikeLaneSegment): {
  facility: RouteFacility;
  designated: boolean;
} {
  const type = segment.facilityType.toUpperCase();
  if (type.includes("CLASS III") || segment.sharrow) {
    return { facility: "shared", designated: false };
  }
  if (type.includes("CLASS I") || segment.raised) {
    return { facility: "protected", designated: true };
  }
  if (type.includes("CLASS II") || type.includes("CLASS IV")) {
    return { facility: "bike_lane", designated: true };
  }
  return { facility: "ordinary", designated: false };
}

function pathLength(coords: BikeCoordinate[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += distanceMeters(coords[i - 1], coords[i]);
  }
  return total;
}

function densify(coords: BikeCoordinate[], stepMeters: number): BikeCoordinate[] {
  if (coords.length < 2) return coords.slice();
  const out: BikeCoordinate[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const length = distanceMeters(a, b);
    if (length < 1) continue;
    const steps = Math.max(1, Math.floor(length / stepMeters));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function buildIndex(network: BikeNetworkResponse): IndexedFeature[] {
  const indexed: IndexedFeature[] = [];
  for (const segment of network.segments) {
    const coords = segment.geometry.coordinates as BikeCoordinate[];
    if (!coords || coords.length < 2) continue;
    const mapped = mapFacility(segment);
    const mid = coords[Math.floor(coords.length / 2)];
    indexed.push({
      segment,
      facility: mapped.facility,
      designated: mapped.designated,
      mid,
      bearing: compassToBearing(segment.direction),
    });
  }
  return indexed;
}

function classifyPoint(
  point: BikeCoordinate,
  travelBearing: number,
  index: IndexedFeature[],
): { facility: RouteFacility; designated: boolean; source: RouteSegmentSource } {
  let best: IndexedFeature | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const feature of index) {
    if (!feature.designated && feature.facility !== "shared") continue;
    const d = distanceMeters(point, feature.mid);
    if (d > MAX_LATERAL_METERS || d >= bestDistance) continue;
    if (!bearingsCompatible(travelBearing, feature.bearing, feature.segment.direct)) {
      continue;
    }
    best = feature;
    bestDistance = d;
  }
  if (!best) {
    return { facility: "ordinary", designated: false, source: "unmatched" };
  }
  return {
    facility: best.facility,
    designated: best.designated,
    source: "sfmta",
  };
}

function transitionWarning(from: RouteFacility, to: RouteFacility): string {
  if (from !== "ordinary" && to === "ordinary") {
    return "Bike lane ends — mixed traffic ahead";
  }
  if (from === "ordinary" && to !== "ordinary") {
    return "Designated bike facility resumes";
  }
  if (from === "protected" && to === "bike_lane") {
    return "Protection ends — painted bike lane ahead";
  }
  if (from === "bike_lane" && to === "protected") {
    return "Entering protected bike facility";
  }
  return `Facility changes from ${from} to ${to}`;
}

export function attributeRouteToSfmta(
  coordinates: BikeCoordinate[],
  network: BikeNetworkResponse,
): AttributionResult {
  const dense = densify(coordinates, 20);
  if (dense.length < 2) {
    return {
      segments: [],
      transitions: [],
      designatedPercent: 0,
      mixedTrafficMeters: 0,
      laneDistanceMeters: 0,
      connectorDistanceMeters: 0,
      laneCoordinates: [],
      connectorCoordinates: [],
      coordinates: dense,
    };
  }

  const index = buildIndex(network);
  const samples: Array<{
    point: BikeCoordinate;
    facility: RouteFacility;
    designated: boolean;
    source: RouteSegmentSource;
  }> = [];

  for (let i = 0; i < dense.length; i++) {
    const point = dense[i];
    const next = dense[Math.min(i + 1, dense.length - 1)];
    const prev = dense[Math.max(i - 1, 0)];
    const travel = bearingDegrees(i === dense.length - 1 ? prev : point, next);
    samples.push({ point, ...classifyPoint(point, travel, index) });
  }

  const segments: AttributedSegment[] = [];
  const transitions: RouteTransition[] = [];
  let currentCoords: BikeCoordinate[] = [samples[0].point];
  let currentFacility = samples[0].facility;
  let currentDesignated = samples[0].designated;
  let currentSource = samples[0].source;
  let unmatchedRun = 0;

  const flush = () => {
    if (currentCoords.length < 2) return;
    segments.push({
      coordinates: currentCoords.slice(),
      distanceMeters: pathLength(currentCoords),
      facility: currentFacility,
      designated: currentDesignated,
      source: currentSource,
    });
  };

  for (let i = 1; i < samples.length; i++) {
    const sample = samples[i];
    const same =
      sample.facility === currentFacility &&
      sample.designated === currentDesignated &&
      sample.source === currentSource;

    if (!same) {
      const gap = distanceMeters(samples[i - 1].point, sample.point);
      if (
        currentSource === "unmatched" &&
        sample.source === "unmatched" &&
        gap <= SPLIT_GAP_METERS
      ) {
        currentCoords.push(sample.point);
        unmatchedRun += gap;
        continue;
      }
      flush();
      transitions.push({
        latitude: sample.point[1],
        longitude: sample.point[0],
        fromFacility: currentFacility,
        toFacility: sample.facility,
        warning: transitionWarning(currentFacility, sample.facility),
      });
      currentCoords = [samples[i - 1].point, sample.point];
      currentFacility = sample.facility;
      currentDesignated = sample.designated;
      currentSource = sample.source;
      unmatchedRun = sample.source === "unmatched" ? gap : 0;
      continue;
    }

    currentCoords.push(sample.point);
    if (sample.source === "unmatched") unmatchedRun += distanceMeters(samples[i - 1].point, sample.point);
    else unmatchedRun = 0;
  }
  flush();

  let laneDistanceMeters = 0;
  let mixedTrafficMeters = 0;
  const laneCoordinates: BikeCoordinate[] = [];
  const connectorCoordinates: BikeCoordinate[][] = [];
  const allCoordinates: BikeCoordinate[] = [];

  for (const segment of segments) {
    if (segment.designated) {
      laneDistanceMeters += segment.distanceMeters;
      for (const point of segment.coordinates) {
        const previous = laneCoordinates[laneCoordinates.length - 1];
        if (!previous || distanceMeters(previous, point) >= 1) laneCoordinates.push(point);
      }
    } else {
      mixedTrafficMeters += segment.distanceMeters;
      connectorCoordinates.push(segment.coordinates);
    }
    for (const point of segment.coordinates) {
      const previous = allCoordinates[allCoordinates.length - 1];
      if (!previous || distanceMeters(previous, point) >= 1) allCoordinates.push(point);
    }
  }

  const total = laneDistanceMeters + mixedTrafficMeters;
  const designatedPercent = total > 0 ? (100 * laneDistanceMeters) / total : 0;

  return {
    segments,
    transitions,
    designatedPercent,
    mixedTrafficMeters,
    laneDistanceMeters,
    connectorDistanceMeters: mixedTrafficMeters,
    laneCoordinates,
    connectorCoordinates,
    coordinates: allCoordinates.length >= 2 ? allCoordinates : dense,
  };
}

export function jaccardOverlap(
  a: BikeCoordinate[],
  b: BikeCoordinate[],
): number {
  const cell = (point: BikeCoordinate) =>
    `${point[1].toFixed(4)},${point[0].toFixed(4)}`;
  const setA = new Set(densify(a, 25).map(cell));
  const setB = new Set(densify(b, 25).map(cell));
  let intersection = 0;
  for (const key of setA) if (setB.has(key)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
