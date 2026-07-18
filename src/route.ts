// Dijkstra-based routing over the RoadGraph, with an optional "prefer shade" weighting.

import * as turf from '@turf/turf';
import type { GraphEdge, RouteResult } from './types';
import type { RoadGraph } from './graph';
import type { ShadowPolygon } from './shadow';

/** Extra "cost" applied per meter of sun-exposed path length, relative to 1 for shaded meters. */
const SHADE_PENALTY_PER_METER = 6;

/** How many points to sample along each edge when estimating its shaded fraction. */
function sampleCountForEdge(distanceMeters: number): number {
  return Math.min(8, Math.max(2, Math.ceil(distanceMeters / 4)));
}

/**
 * Computes, for every distinct edge geometry in the graph, the fraction (0-1) of its
 * length that falls inside any shadow polygon. Keyed by a coordinate-based signature so
 * both directions of the same physical segment share one lookup.
 */
export function computeEdgeShadeFractions(graph: RoadGraph, shadows: ShadowPolygon[]): Map<string, number> {
  const result = new Map<string, number>();
  if (shadows.length === 0) {
    return result; // no shadows => everything is 0% shaded, callers treat missing key as 0
  }

  const seen = new Set<string>();
  for (const edges of graph.adjacency.values()) {
    for (const edge of edges) {
      const key = edgeSignature(edge);
      if (seen.has(key)) continue;
      seen.add(key);

      const [a, b] = edge.coords;
      const n = sampleCountForEdge(edge.distance);
      let shadedSamples = 0;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const sample: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (isPointInAnyShadow(sample, shadows)) shadedSamples++;
      }
      result.set(key, shadedSamples / n);
    }
  }
  return result;
}

function edgeSignature(edge: GraphEdge): string {
  const [a, b] = edge.coords;
  // order-independent so both directions of the same segment map to the same key
  const p1 = `${a[0].toFixed(7)},${a[1].toFixed(7)}`;
  const p2 = `${b[0].toFixed(7)},${b[1].toFixed(7)}`;
  return p1 < p2 ? `${p1}|${p2}` : `${p2}|${p1}`;
}

function isPointInAnyShadow(coord: [number, number], shadows: ShadowPolygon[]): boolean {
  const pt = turf.point(coord);
  for (const s of shadows) {
    if (turf.booleanPointInPolygon(pt, s.polygon)) return true;
  }
  return false;
}

interface DijkstraOptions {
  weightFn: (edge: GraphEdge) => number;
}

function dijkstra(graph: RoadGraph, startId: string, endId: string, options: DijkstraOptions): { nodeIds: string[]; edges: GraphEdge[] } | null {
  const dist = new Map<string, number>();
  const prevEdge = new Map<string, GraphEdge>();
  const visited = new Set<string>();

  for (const id of graph.nodes.keys()) dist.set(id, Infinity);
  dist.set(startId, 0);

  // Simple array-based priority queue - graph is small (~hundreds of nodes), so O(V^2) is plenty fast.
  const unvisited = new Set(graph.nodes.keys());

  while (unvisited.size > 0) {
    let currentId: string | null = null;
    let currentDist = Infinity;
    for (const id of unvisited) {
      const d = dist.get(id) ?? Infinity;
      if (d < currentDist) {
        currentDist = d;
        currentId = id;
      }
    }
    if (currentId === null || currentDist === Infinity) break;
    unvisited.delete(currentId);
    visited.add(currentId);

    if (currentId === endId) break;

    const edges = graph.adjacency.get(currentId) ?? [];
    for (const edge of edges) {
      if (visited.has(edge.to)) continue;
      const w = options.weightFn(edge);
      const alt = currentDist + w;
      if (alt < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, alt);
        prevEdge.set(edge.to, edge);
      }
    }
  }

  if ((dist.get(endId) ?? Infinity) === Infinity) return null;

  // reconstruct path
  const nodeIds: string[] = [endId];
  const edges: GraphEdge[] = [];
  let cursor = endId;
  while (cursor !== startId) {
    const edge = prevEdge.get(cursor);
    if (!edge) return null; // shouldn't happen if dist was finite
    edges.push(edge);
    cursor = edge.from;
    nodeIds.push(cursor);
  }
  nodeIds.reverse();
  edges.reverse();
  return { nodeIds, edges };
}

function buildRouteResult(pathData: { nodeIds: string[]; edges: GraphEdge[] }, shadeFractions: Map<string, number>): RouteResult {
  let totalDistance = 0;
  let shadedDistance = 0;
  const coordinates: [number, number][] = [];

  pathData.edges.forEach((edge, i) => {
    totalDistance += edge.distance;
    const fraction = shadeFractions.get(edgeSignature(edge)) ?? 0;
    shadedDistance += edge.distance * fraction;
    if (i === 0) coordinates.push(edge.coords[0]);
    coordinates.push(edge.coords[1]);
  });

  return {
    nodeIds: pathData.nodeIds,
    edges: pathData.edges,
    distanceMeters: totalDistance,
    shadeRatio: totalDistance > 0 ? shadedDistance / totalDistance : 0,
    coordinates,
  };
}

export interface RoutePair {
  shortest: RouteResult | null;
  shaded: RouteResult | null;
}

/** Computes both the pure-shortest-distance route and the shade-preferring route. */
export function computeRoutes(graph: RoadGraph, startId: string, endId: string, shadeFractions: Map<string, number>): RoutePair {
  const shortestPath = dijkstra(graph, startId, endId, { weightFn: (e) => e.distance });
  const shadedPath = dijkstra(graph, startId, endId, {
    weightFn: (e) => {
      const fraction = shadeFractions.get(edgeSignature(e)) ?? 0;
      const sunnyLength = e.distance * (1 - fraction);
      return e.distance + sunnyLength * SHADE_PENALTY_PER_METER;
    },
  });

  return {
    shortest: shortestPath ? buildRouteResult(shortestPath, shadeFractions) : null,
    shaded: shadedPath ? buildRouteResult(shadedPath, shadeFractions) : null,
  };
}
