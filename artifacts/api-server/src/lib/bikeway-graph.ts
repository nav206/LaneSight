import type { BikeNetworkResponse } from "@workspace/api-zod";

export type BikeCoordinate = [number, number];

interface DirectedEdge {
  to: string;
  distanceMeters: number;
  coordinates: BikeCoordinate[];
}

interface BikeNetworkGraph {
  adjacency: Map<string, DirectedEdge[]>;
  incoming: Map<string, number>;
  points: Map<string, BikeCoordinate>;
}

interface NodeCandidate {
  key: string;
  distanceMeters: number;
}

interface QueueEntry {
  key: string;
  distanceMeters: number;
}

interface PreviousNode {
  from: string;
  coordinates: BikeCoordinate[];
}

export interface MappedBikewayPath {
  startCoordinate: BikeCoordinate;
  endCoordinate: BikeCoordinate;
  laneCoordinates: BikeCoordinate[];
  laneDistanceMeters: number;
}

const MAX_ACCESS_DISTANCE_METERS = 1_200;
const MAX_CANDIDATES = 30;
let cachedGraph:
  | { sourceUpdatedAt: string; graph: BikeNetworkGraph }
  | undefined;

class MinHeap {
  private readonly values: QueueEntry[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: QueueEntry): void {
    const values = this.values;
    values.push(value);
    let index = values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (values[parent].distanceMeters <= value.distanceMeters) break;
      values[index] = values[parent];
      index = parent;
    }
    values[index] = value;
  }

  pop(): QueueEntry | undefined {
    const values = this.values;
    if (values.length === 0) return undefined;
    const first = values[0];
    const last = values.pop();
    if (values.length > 0 && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= values.length) break;
        const child =
          right < values.length &&
          values[right].distanceMeters < values[left].distanceMeters
            ? right
            : left;
        if (values[child].distanceMeters >= last.distanceMeters) break;
        values[index] = values[child];
        index = child;
      }
      values[index] = last;
    }
    return first;
  }
}

function nodeKey(point: BikeCoordinate): string {
  return `${Math.round(point[0] * 100_000)},${Math.round(point[1] * 100_000)}`;
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

function coordinatesToPoints(coordinates: number[][]): BikeCoordinate[] {
  return coordinates.flatMap((coordinate) => {
    const longitude = coordinate[0];
    const latitude = coordinate[1];
    if (
      typeof longitude !== "number" ||
      typeof latitude !== "number" ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude)
    ) {
      return [];
    }
    return [[longitude, latitude]];
  });
}

function reverseForTravelDirection(segment: {
  direction: string | null;
  direct: string | null;
  points: BikeCoordinate[];
}): boolean | null {
  const direct = segment.direct?.toUpperCase();
  if (direct === "2W") return false;
  if (direct !== "1W" || segment.points.length < 2) return null;

  const direction = segment.direction?.toUpperCase();
  const first = segment.points[0];
  const last = segment.points[segment.points.length - 1];
  let delta: number;

  switch (direction) {
    case "E":
      delta = last[0] - first[0];
      break;
    case "W":
      delta = first[0] - last[0];
      break;
    case "N":
      delta = last[1] - first[1];
      break;
    case "S":
      delta = first[1] - last[1];
      break;
    default:
      return null;
  }

  if (Math.abs(delta) < 1e-10) return null;
  return delta < 0;
}

function buildGraph(network: BikeNetworkResponse): BikeNetworkGraph {
  const adjacency = new Map<string, DirectedEdge[]>();
  const incoming = new Map<string, number>();
  const points = new Map<string, BikeCoordinate>();

  const addEdge = (from: BikeCoordinate, to: BikeCoordinate) => {
    const fromKey = nodeKey(from);
    const toKey = nodeKey(to);
    if (fromKey === toKey) return;

    points.set(fromKey, points.get(fromKey) ?? from);
    points.set(toKey, points.get(toKey) ?? to);
    const edge: DirectedEdge = {
      to: toKey,
      distanceMeters: distanceMeters(from, to),
      coordinates: [from, to],
    };
    const edges = adjacency.get(fromKey) ?? [];
    edges.push(edge);
    adjacency.set(fromKey, edges);
    incoming.set(toKey, (incoming.get(toKey) ?? 0) + 1);
  };

  for (const segment of network.segments) {
    const classType = segment.facilityType.trim().toUpperCase();
    if (!["CLASS I", "CLASS II", "CLASS IV"].includes(classType)) continue;

    const segmentPoints = coordinatesToPoints(segment.geometry.coordinates);
    if (segmentPoints.length < 2) continue;
    const reverse = reverseForTravelDirection({
      direction: segment.direction,
      direct: segment.direct,
      points: segmentPoints,
    });
    if (reverse === null) continue;
    const ordered = reverse ? [...segmentPoints].reverse() : segmentPoints;

    for (let index = 1; index < ordered.length; index += 1) {
      const from = ordered[index - 1];
      const to = ordered[index];
      addEdge(from, to);
      if (segment.direct?.toUpperCase() === "2W") addEdge(to, from);
    }
  }

  return { adjacency, incoming, points };
}

function getGraph(network: BikeNetworkResponse): BikeNetworkGraph {
  if (cachedGraph?.sourceUpdatedAt === network.sourceUpdatedAt) {
    return cachedGraph.graph;
  }
  const graph = buildGraph(network);
  cachedGraph = { sourceUpdatedAt: network.sourceUpdatedAt, graph };
  return graph;
}

function nearestCandidates(
  graph: BikeNetworkGraph,
  location: BikeCoordinate,
  isStart: boolean,
): NodeCandidate[] {
  const candidates: NodeCandidate[] = [];
  for (const [key, point] of graph.points) {
    const connected =
      isStart
        ? (graph.adjacency.get(key)?.length ?? 0) > 0
        : (graph.incoming.get(key) ?? 0) > 0;
    if (!connected) continue;
    const distance = distanceMeters(location, point);
    if (distance <= MAX_ACCESS_DISTANCE_METERS) {
      candidates.push({ key, distanceMeters: distance });
    }
  }
  return candidates
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, MAX_CANDIDATES);
}

function joinCoordinates(parts: BikeCoordinate[][]): BikeCoordinate[] {
  const result: BikeCoordinate[] = [];
  for (const part of parts) {
    for (const coordinate of part) {
      const previous = result[result.length - 1];
      if (!previous || distanceMeters(previous, coordinate) >= 1) {
        result.push(coordinate);
      }
    }
  }
  return result;
}

export function findMappedBikewayPath(
  network: BikeNetworkResponse,
  origin: BikeCoordinate,
  destination: BikeCoordinate,
): MappedBikewayPath | null {
  const graph = getGraph(network);
  const starts = nearestCandidates(graph, origin, true);
  const destinations = nearestCandidates(graph, destination, false);
  if (starts.length === 0 || destinations.length === 0) return null;

  const destinationByKey = new Map(destinations.map((candidate) => [candidate.key, candidate]));
  const distances = new Map<string, number>();
  const startAccessDistances = new Map<string, number>();
  const rootStart = new Map<string, string>();
  const previous = new Map<string, PreviousNode>();
  const heap = new MinHeap();

  for (const candidate of starts) {
    if (candidate.distanceMeters >= (distances.get(candidate.key) ?? Infinity)) continue;
    distances.set(candidate.key, candidate.distanceMeters);
    startAccessDistances.set(candidate.key, candidate.distanceMeters);
    rootStart.set(candidate.key, candidate.key);
    previous.delete(candidate.key);
    heap.push({ key: candidate.key, distanceMeters: candidate.distanceMeters });
  }

  let best:
    | {
        totalMeters: number;
        end: string;
        start: string;
        laneDistanceMeters: number;
      }
    | undefined;

  while (heap.size > 0) {
    const current = heap.pop();
    if (!current || current.distanceMeters !== distances.get(current.key)) continue;
    if (best && current.distanceMeters >= best.totalMeters) break;

    const destinationCandidate = destinationByKey.get(current.key);
    if (destinationCandidate) {
      const start = rootStart.get(current.key);
      if (start) {
        const laneDistance =
          current.distanceMeters - (startAccessDistances.get(start) ?? Infinity);
        const totalMeters = current.distanceMeters + destinationCandidate.distanceMeters;
        if (laneDistance >= 5 && (!best || totalMeters < best.totalMeters)) {
          best = {
            totalMeters,
            end: current.key,
            start,
            laneDistanceMeters: laneDistance,
          };
        }
      }
    }

    for (const edge of graph.adjacency.get(current.key) ?? []) {
      const distance = current.distanceMeters + edge.distanceMeters;
      if (distance >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, distance);
      rootStart.set(edge.to, rootStart.get(current.key) ?? current.key);
      previous.set(edge.to, { from: current.key, coordinates: edge.coordinates });
      heap.push({ key: edge.to, distanceMeters: distance });
    }
  }

  if (!best) return null;

  const reversedParts: BikeCoordinate[][] = [];
  let current = best.end;
  while (current !== best.start) {
    const link = previous.get(current);
    if (!link) return null;
    reversedParts.push(link.coordinates);
    current = link.from;
  }
  reversedParts.reverse();
  const laneCoordinates = joinCoordinates(reversedParts);
  const startCoordinate = graph.points.get(best.start);
  const endCoordinate = graph.points.get(best.end);
  if (!startCoordinate || !endCoordinate || laneCoordinates.length < 2) return null;

  return {
    startCoordinate,
    endCoordinate,
    laneCoordinates,
    laneDistanceMeters: best.laneDistanceMeters,
  };
}
