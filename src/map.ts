// Leaflet map setup and layer management.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
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
    zoomControl: true,
  }).setView(OTEMACHI_CENTER, 18);

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

export function renderShadows(layers: MapLayers, shadows: ShadowPolygon[]): void {
  layers.shadowLayer.clearLayers();
  for (const shadow of shadows) {
    L.geoJSON(shadow.polygon, {
      style: {
        color: '#333333',
        weight: 0,
        fillColor: '#3a3a3a',
        fillOpacity: 0.35,
      },
    }).addTo(layers.shadowLayer);
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
