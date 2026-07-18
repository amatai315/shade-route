// Builds a routing graph from the roads GeoJSON (LineString network) and
// provides "snap tap point to nearest road" support used by the UI.

import * as turf from '@turf/turf';
import type { GraphEdge, GraphNode, RoadsFeatureCollection } from './types';

const NODE_PRECISION = 7; // ~1cm at this latitude - used to merge coincident vertices into one node
const SNAP_MERGE_EPS_METERS = 0.75; // if the snapped point lands this close to an existing node, reuse it

function nodeKey(lon: number, lat: number): string {
  return `${lon.toFixed(NODE_PRECISION)},${lat.toFixed(NODE_PRECISION)}`;
}

let syntheticCounter = 0;

export class RoadGraph {
  nodes: Map<string, GraphNode> = new Map();
  adjacency: Map<string, GraphEdge[]> = new Map();
  /** Flat list of one directed representative per undirected road segment, used for nearest-edge search. */
  edgeList: GraphEdge[] = [];
  /** Maps each directed edge to its opposite-direction counterpart. */
  private mirror: Map<GraphEdge, GraphEdge> = new Map();

  ensureNode(lon: number, lat: number): string {
    const key = nodeKey(lon, lat);
    if (!this.nodes.has(key)) {
      this.nodes.set(key, { id: key, lat, lon });
      this.adjacency.set(key, []);
    }
    return key;
  }

  private addDirected(fromId: string, toId: string, distance: number, highway: string, coords: [[number, number], [number, number]]): GraphEdge {
    const edge: GraphEdge = {
      id: `${fromId}=>${toId}#${this.adjacency.get(fromId)!.length}`,
      from: fromId,
      to: toId,
      distance,
      highway,
      coords,
    };
    this.adjacency.get(fromId)!.push(edge);
    return edge;
  }

  /** Adds a bidirectional edge between two existing nodes. */
  addSegment(aId: string, bId: string, highway: string): void {
    const a = this.nodes.get(aId)!;
    const b = this.nodes.get(bId)!;
    if (aId === bId) return; // zero-length / duplicate vertex, skip
    const distance = turf.distance([a.lon, a.lat], [b.lon, b.lat], { units: 'meters' });
    if (distance < 0.05) return; // ignore near-duplicate points
    const forward = this.addDirected(aId, bId, distance, highway, [
      [a.lon, a.lat],
      [b.lon, b.lat],
    ]);
    const backward = this.addDirected(bId, aId, distance, highway, [
      [b.lon, b.lat],
      [a.lon, a.lat],
    ]);
    this.mirror.set(forward, backward);
    this.mirror.set(backward, forward);
    this.edgeList.push(forward);
  }

  /** Removes a specific directed edge (and does NOT touch its reverse - caller handles both). */
  private removeDirected(edge: GraphEdge): void {
    const list = this.adjacency.get(edge.from);
    if (!list) return;
    const idx = list.indexOf(edge);
    if (idx >= 0) list.splice(idx, 1);
  }

  /** Splits the undirected edge (fwd + its reverse) at `atLon,atLat`, inserting a new node. Returns the new node id. */
  private splitEdgeAt(fwd: GraphEdge, atLon: number, atLat: number): string {
    const aId = fwd.from;
    const bId = fwd.to;
    const a = this.nodes.get(aId)!;
    const b = this.nodes.get(bId)!;

    const distToA = turf.distance([a.lon, a.lat], [atLon, atLat], { units: 'meters' });
    const distToB = turf.distance([b.lon, b.lat], [atLon, atLat], { units: 'meters' });
    if (distToA < SNAP_MERGE_EPS_METERS) return aId;
    if (distToB < SNAP_MERGE_EPS_METERS) return bId;

    // find and remove both directions of this undirected edge
    const reverse = this.mirror.get(fwd);
    this.removeDirected(fwd);
    if (reverse) this.removeDirected(reverse);

    syntheticCounter += 1;
    const newId = `snap_${syntheticCounter}`;
    this.nodes.set(newId, { id: newId, lat: atLat, lon: atLon, synthetic: true });
    this.adjacency.set(newId, []);

    const aToS = this.addDirected(aId, newId, distToA, fwd.highway, [
      [a.lon, a.lat],
      [atLon, atLat],
    ]);
    const sToA = this.addDirected(newId, aId, distToA, fwd.highway, [
      [atLon, atLat],
      [a.lon, a.lat],
    ]);
    const sToB = this.addDirected(newId, bId, distToB, fwd.highway, [
      [atLon, atLat],
      [b.lon, b.lat],
    ]);
    const bToS = this.addDirected(bId, newId, distToB, fwd.highway, [
      [b.lon, b.lat],
      [atLon, atLat],
    ]);
    this.mirror.set(aToS, sToA);
    this.mirror.set(sToA, aToS);
    this.mirror.set(sToB, bToS);
    this.mirror.set(bToS, sToB);
    this.edgeList.push(aToS, sToB);

    return newId;
  }

  /**
   * Finds the nearest point on the road network to (lat, lon) and splits the
   * corresponding edge there, returning the new (or reused) node id + its coordinates.
   * Mutates this graph - callers should operate on a clone per selection cycle.
   */
  snapToNetwork(lat: number, lon: number): { nodeId: string; lat: number; lon: number } | null {
    if (this.edgeList.length === 0) return null;
    const tapPoint = turf.point([lon, lat]);

    let bestEdge: GraphEdge | null = null;
    let bestDist = Infinity;
    let bestPoint: [number, number] | null = null;

    for (const edge of this.edgeList) {
      // guard against an edge that has already been removed from the graph by a previous split
      if (!this.adjacency.get(edge.from)?.includes(edge)) continue;
      const line = turf.lineString(edge.coords);
      const snapped = turf.nearestPointOnLine(line, tapPoint, { units: 'meters' });
      const dist = snapped.properties.dist ?? Infinity;
      if (dist < bestDist) {
        bestDist = dist;
        bestEdge = edge;
        bestPoint = snapped.geometry.coordinates as [number, number];
      }
    }

    if (!bestEdge || !bestPoint) return null;
    const nodeId = this.splitEdgeAt(bestEdge, bestPoint[0], bestPoint[1]);
    const node = this.nodes.get(nodeId)!;
    return { nodeId, lat: node.lat, lon: node.lon };
  }

  /** Deep-enough clone so splitting edges on the clone never affects the original graph. */
  clone(): RoadGraph {
    const copy = new RoadGraph();
    copy.nodes = new Map(this.nodes);
    copy.adjacency = new Map();
    for (const [k, v] of this.adjacency) {
      copy.adjacency.set(k, v.slice());
    }
    copy.edgeList = this.edgeList.slice();
    copy.mirror = new Map(this.mirror);
    return copy;
  }
}

export function buildGraphFromRoads(geojson: RoadsFeatureCollection): RoadGraph {
  const graph = new RoadGraph();
  for (const feature of geojson.features) {
    const coords = feature.geometry.coordinates;
    const highway = feature.properties.highway;
    let prevId: string | null = null;
    for (const [lon, lat] of coords) {
      const id = graph.ensureNode(lon, lat);
      if (prevId !== null) {
        graph.addSegment(prevId, id, highway);
      }
      prevId = id;
    }
  }
  return graph;
}
