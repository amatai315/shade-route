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

/** Grid cell size (meters) used to spatially index shadow polygons for fast point lookups. */
const SHADOW_GRID_CELL_METERS = 100;
const METERS_PER_DEGREE_LAT = 111320;

/**
 * Uniform grid spatial index over shadow polygons: each polygon is registered into every
 * cell its bounding box overlaps, so a point-in-cell lookup only needs to test a small
 * handful of nearby polygons instead of the whole set.
 */
interface ShadowGridIndex {
  cellSizeDegLon: number;
  cellSizeDegLat: number;
  cells: Map<string, ShadowPolygon[]>;
}

function buildShadowGridIndex(shadows: ShadowPolygon[]): ShadowGridIndex {
  // Use a representative latitude (first shadow's bbox) to convert the meter-based cell
  // size into degrees-of-longitude, correcting for latitude distortion. Good enough for a
  // grid whose only job is coarse candidate filtering (exact test happens afterwards).
  const refLat = shadows.length > 0 ? turf.bbox(shadows[0].polygon)[1] : 35.68;
  const metersPerDegLon = METERS_PER_DEGREE_LAT * Math.cos((refLat * Math.PI) / 180);
  const cellSizeDegLat = SHADOW_GRID_CELL_METERS / METERS_PER_DEGREE_LAT;
  const cellSizeDegLon = SHADOW_GRID_CELL_METERS / metersPerDegLon;

  const cells = new Map<string, ShadowPolygon[]>();
  for (const shadow of shadows) {
    const [minX, minY, maxX, maxY] = turf.bbox(shadow.polygon);
    const cx0 = Math.floor(minX / cellSizeDegLon);
    const cx1 = Math.floor(maxX / cellSizeDegLon);
    const cy0 = Math.floor(minY / cellSizeDegLat);
    const cy1 = Math.floor(maxY / cellSizeDegLat);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = `${cx},${cy}`;
        let list = cells.get(key);
        if (!list) {
          list = [];
          cells.set(key, list);
        }
        list.push(shadow);
      }
    }
  }

  return { cellSizeDegLon, cellSizeDegLat, cells };
}

function candidateShadowsForPoint(index: ShadowGridIndex, coord: [number, number]): ShadowPolygon[] {
  const cx = Math.floor(coord[0] / index.cellSizeDegLon);
  const cy = Math.floor(coord[1] / index.cellSizeDegLat);
  return index.cells.get(`${cx},${cy}`) ?? [];
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

  // Built once per call (shadow polygons don't change while we iterate all edges/samples),
  // so per-sample lookups only test the handful of shadows near that point instead of
  // linearly scanning every shadow polygon in the area.
  const index = buildShadowGridIndex(shadows);

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
        if (isPointInAnyShadow(sample, index)) shadedSamples++;
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

function isPointInAnyShadow(coord: [number, number], index: ShadowGridIndex): boolean {
  const candidates = candidateShadowsForPoint(index, coord);
  if (candidates.length === 0) return false;
  const pt = turf.point(coord);
  for (const s of candidates) {
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
