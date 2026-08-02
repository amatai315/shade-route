// Leaflet map setup and layer management.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import * as turf from '@turf/turf';
import type { ShadowPolygon } from './shadow';
import type { GraphEdge, PlacesFeatureCollection, RouteResult } from './types';

export const OTEMACHI_CENTER: L.LatLngTuple = [35.6862, 139.7671];

const ROADS_NORMAL_OPACITY = 0.6;
// Shared "background context" opacity for underground mode (ui.ts's binary 地上/地下 toggle -
// see setUndergroundMode below): both the underground-mode roads layer (which shows only the
// indoor/underground network, dimly) and the surface-side portion of a rendered route line
// while underground mode is active use this same value, so the two read as one consistent
// "de-emphasized, but still there" treatment.
const UNDERGROUND_CONTEXT_OPACITY = 0.2;

/** Static style used for the roads layer in normal (地上) mode, and per-feature style used in
 *  underground (地下) mode: only `indoor_or_underground` roads are shown (dimly, as background
 *  context) - surface roads are opacity 0, i.e. present but invisible, rather than removed,
 *  so switching back to 地上 is a plain `setStyle` call rather than a re-render. */
function roadsStyle(underground: boolean): (feature?: GeoJSON.Feature) => L.PathOptions {
  return (feature) => {
    if (!underground) {
      return { color: '#555555', weight: 2, opacity: ROADS_NORMAL_OPACITY };
    }
    const isUnderground = feature?.properties?.indoor_or_underground === true;
    return { color: '#555555', weight: 2, opacity: isUnderground ? UNDERGROUND_CONTEXT_OPACITY : 0 };
  };
}

export interface MapLayers {
  map: L.Map;
  tileLayer: L.TileLayer;
  roadsLayer: L.GeoJSON;
  shadowLayer: L.LayerGroup;
  shortestRouteLayer: L.LayerGroup;
  shadedRouteLayer: L.LayerGroup;
  markerLayer: L.LayerGroup;
  currentLocationLayer: L.LayerGroup;
  exitMarkerLayer: L.LayerGroup;
}

export function initMap(containerId: string): MapLayers {
  const map = L.map(containerId, {
    zoomControl: false,
  }).setView(OTEMACHI_CENTER, 18);

  L.control.zoom({ position: 'topright' }).addTo(map);

  const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const roadsLayer = L.geoJSON(undefined, {
    style: roadsStyle(false),
  }).addTo(map);

  const shadowLayer = L.layerGroup().addTo(map);
  const shortestRouteLayer = L.layerGroup().addTo(map);
  const shadedRouteLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const currentLocationLayer = L.layerGroup().addTo(map);
  const exitMarkerLayer = L.layerGroup().addTo(map);

  return {
    map,
    tileLayer,
    roadsLayer,
    shadowLayer,
    shortestRouteLayer,
    shadedRouteLayer,
    markerLayer,
    currentLocationLayer,
    exitMarkerLayer,
  };
}

export function renderRoads(layers: MapLayers, roadsGeoJson: GeoJSON.FeatureCollection): void {
  layers.roadsLayer.clearLayers();
  layers.roadsLayer.addData(roadsGeoJson);
}

/** Switches the map between the two modes of ui.ts's binary 地上/地下 toggle. 地上 is the
 *  existing normal rendering (untouched); 地下 is a "schematic" mode: the OSM tile layer is
 *  removed entirely (not just faded) so it also stops issuing further tile requests while
 *  hidden, which reveals #map's own light-gray CSS background (style.css) as the canvas -
 *  no separate background element needed. The cast-shadow layer is likewise removed/added
 *  wholesale rather than restyled, since 地下 mode hides it completely rather than dimming it.
 *  The roads layer is restyled in place via setStyle (see roadsStyle) rather than re-rendered,
 *  since the underlying GeoJSON data doesn't change - only which features are visible and how. */
export function setUndergroundMode(layers: MapLayers, underground: boolean): void {
  if (underground) {
    layers.map.removeLayer(layers.tileLayer);
    layers.map.removeLayer(layers.shadowLayer);
  } else {
    layers.map.addLayer(layers.tileLayer);
    layers.map.addLayer(layers.shadowLayer);
  }
  layers.roadsLayer.setStyle(roadsStyle(underground));
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

/** Splits a route's edges into contiguous same-indoorOrUnderground runs, so each run can be
 *  drawn with its own dash pattern and independently faded in/out of "background context"
 *  opacity when the 地下 toggle (ui.ts) is active (see setRouteSegmentDimmed). */
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

const ROUTE_SEGMENT_NORMAL_OPACITY = 0.85; // matches renderRoute's previous fixed opacity

/** A single contiguous same-dash-style run of a rendered route, with the polyline Leaflet
 *  object drawn for it. Returned by renderRoute so callers (ui.ts's 地上/地下 toggle) can
 *  independently fade each segment's opacity later, without re-rendering the whole route. */
export interface RouteRenderSegment {
  indoorOrUnderground: boolean;
  polyline: L.Polyline;
}

export function renderRoute(layer: L.LayerGroup, route: RouteResult | null, color: string): RouteRenderSegment[] {
  layer.clearLayers();
  if (!route) return [];
  const rendered: RouteRenderSegment[] = [];
  for (const segment of splitRouteSegments(route.edges)) {
    const polyline = L.polyline(toLatLngs(segment.coords), {
      color,
      weight: 5,
      opacity: ROUTE_SEGMENT_NORMAL_OPACITY,
      lineCap: 'round',
      dashArray: segment.indoorOrUnderground ? INDOOR_DASH_ARRAY : undefined,
    }).addTo(layer);
    rendered.push({ indoorOrUnderground: segment.indoorOrUnderground, polyline });
  }
  return rendered;
}

/** Fades/restores one route-line segment for the 地上/地下 toggle (see ui.ts) - called per
 *  segment returned by renderRoute rather than re-rendering, so toggling is just a style
 *  update. Shares UNDERGROUND_CONTEXT_OPACITY with the underground-mode roads layer so a
 *  dimmed surface-side route segment reads the same as the dimmed background around it. */
export function setRouteSegmentDimmed(polyline: L.Polyline, dimmed: boolean): void {
  polyline.setStyle({ opacity: dimmed ? UNDERGROUND_CONTEXT_OPACITY : ROUTE_SEGMENT_NORMAL_OPACITY });
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

/** Renders the given subway/station-entrance features (each expected to have a `ref`, e.g.
 *  "B4") as small numbered badge markers. Like the shadow layer, this is route-relevant only:
 *  callers are expected to pass just the subset of entrances that sit at a genuine
 *  floor-transition point on the currently computed route (see `findExitsAtTransitions` in
 *  ui.ts), not the full places dataset - so the layer is empty until a route exists and
 *  updates whenever the route is (re)computed, instead of showing every entrance in the
 *  loaded area as permanent map clutter. Always rendered at full visibility, in both the
 *  地上 and 地下 map modes (see ui.ts) - unlike the roads/shadow/route layers, exit markers
 *  are never faded or hidden by the toggle. */
export function renderExitMarkers(layer: L.LayerGroup, features: PlacesFeatureCollection['features']): void {
  layer.clearLayers();
  for (const feature of features) {
    const ref = feature.properties.ref;
    if (!ref) continue;
    const [lon, lat] = feature.geometry.coordinates;
    const icon = L.divIcon({
      className: 'exit-marker-icon',
      html: `<span class="exit-marker-badge">${ref}</span>`,
      iconSize: [24, 20],
      iconAnchor: [12, 10],
    });
    L.marker([lat, lon], { icon }).bindPopup(feature.properties.name).addTo(layer);
  }
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
