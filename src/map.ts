// Leaflet map setup and layer management.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import * as turf from '@turf/turf';
import type { ShadowPolygon } from './shadow';
import type { GraphEdge, RouteResult } from './types';

export const OTEMACHI_CENTER: L.LatLngTuple = [35.6862, 139.7671];

export interface MapLayers {
  map: L.Map;
  roadsLayer: L.GeoJSON;
  shadowLayer: L.LayerGroup;
  shortestRouteLayer: L.LayerGroup;
  shadedRouteLayer: L.LayerGroup;
  markerLayer: L.LayerGroup;
  currentLocationLayer: L.LayerGroup;
}

export function initMap(containerId: string): MapLayers {
  const map = L.map(containerId, {
    zoomControl: false,
  }).setView(OTEMACHI_CENTER, 18);

  L.control.zoom({ position: 'topright' }).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const roadsLayer = L.geoJSON(undefined, {
    style: {
      color: '#555555',
      weight: 2,
      opacity: 0.6,
    },
  }).addTo(map);

  const shadowLayer = L.layerGroup().addTo(map);
  const shortestRouteLayer = L.layerGroup().addTo(map);
  const shadedRouteLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const currentLocationLayer = L.layerGroup().addTo(map);

  return { map, roadsLayer, shadowLayer, shortestRouteLayer, shadedRouteLayer, markerLayer, currentLocationLayer };
}

export function renderRoads(layers: MapLayers, roadsGeoJson: GeoJSON.FeatureCollection): void {
  layers.roadsLayer.clearLayers();
  layers.roadsLayer.addData(roadsGeoJson);
}

// Single shared style used for the (unioned) shadow layer. 0.48 is chosen so an isolated
// small building's shadow reads at roughly the same visual darkness that 2-3 overlapping
// shadows used to produce under the old per-polygon compositing (~0.58-0.73 apparent
// opacity), without going so dark that the basemap/route lines disappear underneath it.
const SHADOW_STYLE: L.PathOptions = {
  color: '#333333',
  weight: 0,
  fillColor: '#3a3a3a',
  fillOpacity: 0.48,
};

/**
 * Renders shadow polygons as a single merged layer so that overlapping shadows (e.g. from
 * densely packed buildings, or one large building's shadow crossing another) don't stack
 * multiple semi-transparent fills on top of each other and read as darker than an isolated
 * small building's shadow. All shadows are unioned into one Polygon/MultiPolygon geometry
 * before being drawn, so every shaded area gets exactly the same fillOpacity regardless of
 * how many building shadows contributed to it.
 */
export function renderShadows(layers: MapLayers, shadows: ShadowPolygon[]): void {
  layers.shadowLayer.clearLayers();
  if (shadows.length === 0) return;

  if (shadows.length === 1) {
    L.geoJSON(shadows[0].polygon, { style: SHADOW_STYLE }).addTo(layers.shadowLayer);
    return;
  }

  let merged: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null = null;
  try {
    merged = turf.union(turf.featureCollection(shadows.map((s) => s.polygon)));
  } catch {
    // Degenerate/self-intersecting input geometry - fall back to drawing individually below
    // rather than dropping the shadows entirely.
    merged = null;
  }

  if (merged) {
    L.geoJSON(merged, { style: SHADOW_STYLE }).addTo(layers.shadowLayer);
  } else {
    for (const shadow of shadows) {
      L.geoJSON(shadow.polygon, { style: SHADOW_STYLE }).addTo(layers.shadowLayer);
    }
  }
}

function toLatLngs(coords: [number, number][]): L.LatLngTuple[] {
  return coords.map(([lon, lat]) => [lat, lon]);
}

/** Dash pattern used for the indoor/underground portion of a rendered route - these segments
 *  have no rendered shadow polygon backing their "shaded" classification (unlike surface
 *  segments, which sit visibly under the gray shadow layer), so the line style itself needs
 *  to signal why the segment counts as shaded. */
const INDOOR_DASH_ARRAY = '6, 6';

interface RouteSubSegment {
  indoorOrUnderground: boolean;
  coords: [number, number][];
}

/** Splits a route's edges into contiguous runs that share the same indoorOrUnderground value,
 *  so each run can be drawn with its own line style while keeping edge-to-edge geometry intact. */
function splitRouteSegments(edges: GraphEdge[]): RouteSubSegment[] {
  const segments: RouteSubSegment[] = [];
  let current: RouteSubSegment | null = null;
  for (const edge of edges) {
    if (!current || current.indoorOrUnderground !== edge.indoorOrUnderground) {
      if (current) segments.push(current);
      current = { indoorOrUnderground: edge.indoorOrUnderground, coords: [edge.coords[0], edge.coords[1]] };
    } else {
      current.coords.push(edge.coords[1]);
    }
  }
  if (current) segments.push(current);
  return segments;
}

export function renderRoute(layer: L.LayerGroup, route: RouteResult | null, color: string): void {
  layer.clearLayers();
  if (!route) return;
  for (const segment of splitRouteSegments(route.edges)) {
    L.polyline(toLatLngs(segment.coords), {
      color,
      weight: 5,
      opacity: 0.85,
      lineCap: 'round',
      dashArray: segment.indoorOrUnderground ? INDOOR_DASH_ARRAY : undefined,
    }).addTo(layer);
  }
}

export type MarkerKind = 'start' | 'end';

export function renderMarker(layer: L.LayerGroup, kind: MarkerKind, lat: number, lon: number): L.CircleMarker {
  const color = kind === 'start' ? '#2e7d32' : '#c62828';
  const marker = L.circleMarker([lat, lon], {
    radius: 9,
    color: '#ffffff',
    weight: 2,
    fillColor: color,
    fillOpacity: 1,
  }).addTo(layer);
  return marker;
}

// Distinct from both the green start marker and the red end/shortest-route color, and from
// the darker blue already used for the shaded-route line, so all three read as separate
// things when a route and a live GPS fix are on screen together.
const CURRENT_LOCATION_COLOR = '#4285f4';

/** Draws the live GPS fix as a small solid dot plus a semi-transparent accuracy circle
 *  (radius in meters, per `L.circle`'s default unit). Mirrors `renderMarker`'s
 *  clear-then-draw-into-a-dedicated-layer convention so it can be redrawn independently
 *  of the start/end markers on every position update. */
export function renderCurrentLocation(layer: L.LayerGroup, lat: number, lon: number, accuracy: number): void {
  layer.clearLayers();
  L.circle([lat, lon], {
    radius: accuracy,
    color: CURRENT_LOCATION_COLOR,
    weight: 1,
    opacity: 0.4,
    fillColor: CURRENT_LOCATION_COLOR,
    fillOpacity: 0.15,
  }).addTo(layer);
  L.circleMarker([lat, lon], {
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: CURRENT_LOCATION_COLOR,
    fillOpacity: 1,
  }).addTo(layer);
}
