// Leaflet map setup and layer management.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import * as turf from '@turf/turf';
import type { ShadowPolygon } from './shadow';
import type { GraphEdge, PlacesFeatureCollection, RouteResult } from './types';

export const OTEMACHI_CENTER: L.LatLngTuple = [35.6862, 139.7671];

// Background dimming levels used by the floor-toggle badge (ui.ts): when the user steps into
// a non-surface floor, the road network and cast-shadow layers recede so the (per-layer-dimmed)
// route line and floor selection read as the focus. Normal values match each layer's existing
// baseline style so restoring to "地上" is an exact round-trip, not an approximation.
const ROADS_NORMAL_OPACITY = 0.6;
const ROADS_DIMMED_OPACITY = 0.2;
const SHADOW_DIMMED_FILL_OPACITY = 0.2;

export interface MapLayers {
  map: L.Map;
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

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const roadsLayer = L.geoJSON(undefined, {
    style: {
      color: '#555555',
      weight: 2,
      opacity: ROADS_NORMAL_OPACITY,
    },
  }).addTo(map);

  const shadowLayer = L.layerGroup().addTo(map);
  const shortestRouteLayer = L.layerGroup().addTo(map);
  const shadedRouteLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const currentLocationLayer = L.layerGroup().addTo(map);
  const exitMarkerLayer = L.layerGroup().addTo(map);

  return {
    map,
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

/** Dims/undims the background road network and cast-shadow layers for the floor-toggle badge
 *  (see ui.ts): when the selected floor isn't the surface, both recede so the map reads as
 *  "focused on this underground level" rather than showing full surface-level detail
 *  underneath a route that isn't actually there right now. shadowLayer holds an L.GeoJSON
 *  child (see renderShadows) rather than being stylable directly - it's a plain LayerGroup,
 *  not a FeatureGroup - so its children are walked and restyled individually. */
export function setBackgroundDimmed(layers: MapLayers, dimmed: boolean): void {
  layers.roadsLayer.setStyle({ opacity: dimmed ? ROADS_DIMMED_OPACITY : ROADS_NORMAL_OPACITY });
  layers.shadowLayer.eachLayer((child) => {
    if (child instanceof L.GeoJSON) {
      child.setStyle({ fillOpacity: dimmed ? SHADOW_DIMMED_FILL_OPACITY : SHADOW_STYLE.fillOpacity });
    }
  });
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
  /** OSM `layer` value shared by every edge in this run - see GraphEdge.layer. */
  layer: number;
  coords: [number, number][];
}

/** Splits a route's edges into contiguous runs that share both the same indoorOrUnderground
 *  value and the same exact `layer` value, so each run can be drawn with its own line style
 *  (dash pattern from indoorOrUnderground) while also being independently addressable for
 *  per-floor opacity toggling (keyed on `layer` - see setRouteSegmentDimmed/ui.ts's floor
 *  badge). Splitting on the finer of the two values is safe: indoorOrUnderground can be true
 *  at layer 0 (e.g. an indoor mall passage), so a layer-only split would wrongly merge runs
 *  that need different dash treatment. */
function splitRouteSegments(edges: GraphEdge[]): RouteSubSegment[] {
  const segments: RouteSubSegment[] = [];
  let current: RouteSubSegment | null = null;
  for (const edge of edges) {
    if (!current || current.indoorOrUnderground !== edge.indoorOrUnderground || current.layer !== edge.layer) {
      if (current) segments.push(current);
      current = { indoorOrUnderground: edge.indoorOrUnderground, layer: edge.layer, coords: [edge.coords[0], edge.coords[1]] };
    } else {
      current.coords.push(edge.coords[1]);
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** Opacity a route-line segment is drawn at once the floor badge is toggled to a level that
 *  doesn't match it - matches ROUTE_SEGMENT_NORMAL_OPACITY's role as "the segment is there but
 *  de-emphasized", not "invisible", mirroring the 0.15-0.3 dimming range used for the
 *  background roads/shadow layers. */
const ROUTE_SEGMENT_NORMAL_OPACITY = 0.85; // matches renderRoute's previous fixed opacity
const ROUTE_SEGMENT_DIMMED_OPACITY = 0.25;

/** A single contiguous same-layer/same-dash-style run of a rendered route, with the polyline
 *  Leaflet object that was drawn for it. Returned by renderRoute so callers (ui.ts's floor
 *  badge) can independently dim/undim each segment's opacity later, without re-rendering the
 *  whole route. */
export interface RouteRenderSegment {
  layer: number;
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
    rendered.push({ layer: segment.layer, polyline });
  }
  return rendered;
}

/** Dims/undims one route-line segment for the floor-toggle badge (see ui.ts) - called per
 *  segment returned by renderRoute rather than re-rendering, so cycling floors is just a
 *  style update. */
export function setRouteSegmentDimmed(polyline: L.Polyline, dimmed: boolean): void {
  polyline.setStyle({ opacity: dimmed ? ROUTE_SEGMENT_DIMMED_OPACITY : ROUTE_SEGMENT_NORMAL_OPACITY });
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

/** Renders the given subway/station-entrance place features (each expected to have a `ref`,
 *  e.g. "B4") as small numbered badge markers. Like the shadow layer, this is route-relevant
 *  only: callers are expected to pass just the subset of entrances that sit at a genuine
 *  floor-transition point on the currently computed route (see `findExitsAtTransitions` in
 *  ui.ts), not the full places dataset - so the layer is empty until a route exists and
 *  updates whenever the route is (re)computed, instead of showing every entrance in the
 *  loaded area as permanent map clutter. */
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
