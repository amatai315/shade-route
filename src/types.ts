// Shared type definitions for the shade-route PoC.

export interface LatLon {
  lat: number;
  lon: number;
}

/** A single node in the routing graph. */
export interface GraphNode {
  id: string;
  lat: number;
  lon: number;
  /** true if this node was inserted at runtime by snapping a tap point onto an edge. */
  synthetic?: boolean;
}

/** A directed adjacency entry stored on GraphNode -> GraphEdge[] lists. */
export interface GraphEdge {
  /** Unique id for this directed edge instance. */
  id: string;
  from: string;
  to: string;
  /** Great-circle distance in meters. */
  distance: number;
  highway: string;
  /** Straight line geometry of this edge segment, [lon, lat] pairs (always 2 points). */
  coords: [[number, number], [number, number]];
}

export interface RouteResult {
  /** Ordered node ids visited. */
  nodeIds: string[];
  /** Ordered edges traversed. */
  edges: GraphEdge[];
  /** Total path distance in meters. */
  distanceMeters: number;
  /** Fraction (0-1) of the path length that lies in shadow. */
  shadeRatio: number;
  /** Ordered [lon, lat] coordinates for rendering. */
  coordinates: [number, number][];
}

/** GeoJSON FeatureCollection of the pedestrian road network, as loaded from data/roads.geojson. */
export interface RoadsFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    properties: { highway: string; id: number | string };
  }>;
}

export interface SunState {
  altitudeDeg: number;
  azimuthDeg: number;
  isDaylight: boolean;
}
