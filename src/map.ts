// Leaflet map setup and layer management.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import * as turf from '@turf/turf';
import type { ShadowPolygon } from './shadow';
import type { RouteResult } from './types';

export const OTEMACHI_CENTER: L.LatLngTuple = [35.6862, 139.7671];

export interface MapLayers {
  map: L.Map;
  roadsLayer: L.GeoJSON;
  shadowLayer: L.LayerGroup;
  shortestRouteLayer: L.LayerGroup;
  shadedRouteLayer: L.LayerGroup;
  markerLayer: L.LayerGroup;
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

  return { map, roadsLayer, shadowLayer, shortestRouteLayer, shadedRouteLayer, markerLayer };
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

export function renderRoute(layer: L.LayerGroup, route: RouteResult | null, color: string): void {
  layer.clearLayers();
  if (!route) return;
  L.polyline(toLatLngs(route.coordinates), {
    color,
    weight: 5,
    opacity: 0.85,
    lineCap: 'round',
  }).addTo(layer);
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
