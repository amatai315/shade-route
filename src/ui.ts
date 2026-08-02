// UI wiring: control panel state, map tap handling, and orchestration of the
// shadow / graph / route modules.

import L from 'leaflet';
import {
  OTEMACHI_CENTER,
  renderCurrentLocation,
  renderExitMarkers,
  renderMarker,
  renderRoute,
  renderShadows,
  setRouteSegmentDimmed,
  setUndergroundMode,
  type MapLayers,
  type RouteRenderSegment,
} from './map';
import { RoadGraph } from './graph';
import {
  computeShadows,
  computeTreeShadows,
  type BuildingsFeatureCollection,
  type ShadowPolygon,
  type TreesFeatureCollection,
} from './shadow';
import { buildShadowGridIndex, computeEdgeShadeFractions, computeRoutes, findShadowsAlongEdges } from './route';
import type { CurrentPosition, GraphEdge, PlacesFeatureCollection, RouteResult, SunState } from './types';

const MAX_SEARCH_RESULTS = 20;

const CATEGORY_LABELS: Record<string, string> = {
  building: '建物',
  shop: '店舗',
  amenity: '施設',
  office: 'オフィス',
  railway: '鉄道',
  tourism: '観光',
};

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** A start/end point only counts as "at" an exit if it's within this many meters of it -
 *  loose enough to cover snapping-to-road drift, tight enough that unrelated nearby exits
 *  (e.g. a different line's entrance across the street) don't get misreported. */
const NEAREST_EXIT_MAX_DISTANCE_M = 40;

/** Which of the two input fields (if any) is currently waiting for the next map tap. */
type ArmedField = 'start' | 'end' | null;

/** off: not tracking. following: tracking + map auto-recenters on every fix. trackingNotFollowing:
 *  still tracking (marker keeps updating) but the user dragged the map away, so auto-recenter
 *  is paused until they tap the locate button again. */
type LocateState = 'off' | 'following' | 'trackingNotFollowing';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

/** Escapes OSM-sourced text (place names, refs) before interpolating into an innerHTML
 *  template string, so it's never misread as markup. */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

interface PointInfo {
  nodeId: string;
  lat: number;
  lon: number;
  /** Place name from a search-result selection; unset for map-tap selections, which show coordinates instead. */
  label?: string;
}

function roundHourDate(source: Date): Date {
  const d = new Date(source.getTime());
  if (d.getMinutes() >= 30) {
    d.setHours(d.getHours() + 1);
  }
  d.setMinutes(0, 0, 0);
  return d;
}

function formatDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startApp(
  baseGraph: RoadGraph,
  buildings: BuildingsFeatureCollection,
  trees: TreesFeatureCollection,
  places: PlacesFeatureCollection,
  layers: MapLayers
): void {
  const dateInput = byId<HTMLInputElement>('date-input');
  const hourSlider = byId<HTMLInputElement>('hour-slider');
  const hourValue = byId<HTMLSpanElement>('hour-value');
  const nowButton = byId<HTMLButtonElement>('now-button');
  const resetButton = byId<HTMLButtonElement>('reset-button');
  const routeButton = byId<HTMLButtonElement>('route-button');
  const fieldStart = byId<HTMLDivElement>('field-start');
  const fieldEnd = byId<HTMLDivElement>('field-end');
  const fieldStartText = byId<HTMLSpanElement>('field-start-text');
  const fieldEndText = byId<HTMLSpanElement>('field-end-text');
  const fieldStartInput = byId<HTMLInputElement>('field-start-input');
  const fieldEndInput = byId<HTMLInputElement>('field-end-input');
  const clearStartButton = byId<HTMLButtonElement>('clear-start');
  const clearEndButton = byId<HTMLButtonElement>('clear-end');
  const routeHint = byId<HTMLDivElement>('route-hint');
  const routeSearchResults = byId<HTMLDivElement>('route-search-results');
  const sunInfo = byId<HTMLDivElement>('sun-info');
  const errorMessage = byId<HTMLDivElement>('error-message');
  const resultPanel = byId<HTMLDivElement>('result-panel');
  const legend = byId<HTMLDivElement>('legend');
  const panel = byId<HTMLDivElement>('panel');
  const panelToggle = byId<HTMLButtonElement>('panel-toggle');
  const routeInputs = byId<HTMLDivElement>('route-inputs');
  const routeInputsToggle = byId<HTMLButtonElement>('route-inputs-toggle');
  const locateButton = byId<HTMLButtonElement>('locate-button');
  const floorToggleButton = byId<HTMLButtonElement>('floor-toggle-button');

  legend.innerHTML = `
    <div class="legend-item"><span class="swatch swatch-shaded"></span>日陰優先ルート</div>
    <div class="legend-item"><span class="swatch swatch-shortest"></span>最短距離ルート</div>
    <div class="legend-item"><span class="swatch swatch-shadow"></span>建物・街路樹の影</div>
    <div class="legend-item"><span class="swatch swatch-indoor"></span>地下・屋内区間(破線)</div>
  `;

  // ---- state ----
  let armedField: ArmedField = null;
  let workingGraph: RoadGraph = baseGraph.clone();
  let startInfo: PointInfo | null = null;
  let endInfo: PointInfo | null = null;
  let startMarker: L.CircleMarker | null = null;
  let endMarker: L.CircleMarker | null = null;
  let currentShadows: ShadowPolygon[] = [];
  let currentSun: SunState | null = null;
  let hasComputedRoute = false;
  let panelCollapsed = false;
  let routeInputsCollapsed = false;
  let locateState: LocateState = 'off';
  let watchId: number | null = null;
  let currentPosition: CurrentPosition | null = null;
  // Manual 地上/地下 toggle - purely a function of the just-computed route's own edges, never
  // of currentPosition/locateState. undergroundToggleVisible is false (badge hidden) whenever
  // there's no computed route or it never crosses between surface and indoor/underground;
  // undergroundSelected is the current binary selection (always resets to false/地上 on a
  // fresh route). routeSegments mirrors startMarker/endMarker's "hold the last-drawn Leaflet
  // object(s) so they can be restyled without re-rendering" pattern: one entry per contiguous
  // indoorOrUnderground run of the rendered shortest+shaded route lines.
  let undergroundToggleVisible = false;
  let undergroundSelected = false;
  let routeSegments: RouteRenderSegment[] = [];

  function showError(msg: string | null): void {
    if (!msg) {
      errorMessage.hidden = true;
      errorMessage.textContent = '';
      return;
    }
    errorMessage.hidden = false;
    errorMessage.textContent = msg;
  }

  function updateFieldDisplays(): void {
    if (startInfo) {
      fieldStartText.textContent = startInfo.label ?? `${startInfo.lat.toFixed(5)}, ${startInfo.lon.toFixed(5)}`;
      fieldStart.classList.add('field-set');
      clearStartButton.hidden = false;
    } else {
      fieldStartText.textContent = 'タップまたは入力で選択';
      fieldStart.classList.remove('field-set');
      clearStartButton.hidden = true;
    }
    if (endInfo) {
      fieldEndText.textContent = endInfo.label ?? `${endInfo.lat.toFixed(5)}, ${endInfo.lon.toFixed(5)}`;
      fieldEnd.classList.add('field-set');
      clearEndButton.hidden = false;
    } else {
      fieldEndText.textContent = 'タップまたは入力で選択';
      fieldEnd.classList.remove('field-set');
      clearEndButton.hidden = true;
    }
  }

  /** Arms/disarms a field for the next map tap or search selection, updating the highlight + hint text.
   *  Swaps the field's static text span for its live search input (and back) via `hidden` toggling,
   *  same pattern used elsewhere in this file (e.g. `clearStartButton.hidden`). */
  function setArmed(field: ArmedField): void {
    armedField = field;
    fieldStart.classList.toggle('field-armed', field === 'start');
    fieldEnd.classList.toggle('field-armed', field === 'end');

    fieldStartText.hidden = field === 'start';
    fieldStartInput.hidden = field !== 'start';
    fieldEndText.hidden = field === 'end';
    fieldEndInput.hidden = field !== 'end';

    if (field === 'start') {
      routeHint.hidden = false;
      routeHint.textContent = '地図をタップするか、この欄に入力して出発地を検索してください';
      fieldStartInput.value = '';
      fieldStartInput.focus();
    } else if (field === 'end') {
      routeHint.hidden = false;
      routeHint.textContent = '地図をタップするか、この欄に入力して目的地を検索してください';
      fieldEndInput.value = '';
      fieldEndInput.focus();
    } else {
      routeHint.hidden = true;
      routeHint.textContent = '';
    }

    // The results list only makes sense while a field is armed - always clear its contents
    // here so no stale query/results survive into the next arm cycle or linger after disarm.
    // Re-rendering (rather than just clearing) when arming lets the "use current location"
    // option appear immediately, before the user types anything.
    routeSearchResults.hidden = !field;
    if (field) {
      renderSearchResults('');
    } else {
      routeSearchResults.innerHTML = '';
    }
  }

  /** "Use current GPS fix" quick action, shown above the filtered place matches. Reuses
   *  confirmSelectionAt exactly like a map tap or a search result - it's just a third way
   *  to supply a point, not a separate confirm path. No label, so the field falls back to
   *  showing coordinates, same as a map-tap selection (a GPS fix isn't a named place). */
  function buildUseCurrentLocationButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'route-search-result route-search-current-location';
    button.textContent = '現在地を使う';
    button.addEventListener('click', () => {
      if (!currentPosition) return;
      confirmSelectionAt(currentPosition.lat, currentPosition.lon);
    });
    return button;
  }

  /** Renders up to MAX_SEARCH_RESULTS places matching `query` (case-insensitive substring),
   *  nearest-to-map-center first, plus the "use current location" option (if a fix is
   *  available) pinned above them. Each result is a button that runs the same confirm path
   *  as a map tap. */
  function renderSearchResults(query: string): void {
    routeSearchResults.innerHTML = '';
    if (armedField && currentPosition) {
      routeSearchResults.appendChild(buildUseCurrentLocationButton());
    }
    const trimmed = query.trim();
    if (!trimmed) return;

    const lower = trimmed.toLowerCase();
    const center = layers.map.getCenter();
    const matches = places.features
      .filter((f) => f.properties.name.toLowerCase().includes(lower))
      .map((f) => ({
        feature: f,
        dist: center.distanceTo(L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0])),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, MAX_SEARCH_RESULTS);

    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'route-search-empty';
      empty.textContent = '見つかりませんでした';
      routeSearchResults.appendChild(empty);
      return;
    }

    for (const { feature } of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'route-search-result';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'route-search-result-name';
      nameSpan.textContent = feature.properties.name;

      const categorySpan = document.createElement('span');
      categorySpan.className = 'route-search-result-category';
      categorySpan.textContent = categoryLabel(feature.properties.category);

      button.appendChild(nameSpan);
      button.appendChild(categorySpan);
      button.addEventListener('click', () => {
        const [lon, lat] = feature.geometry.coordinates;
        confirmSelectionAt(lat, lon, feature.properties.name);
      });

      routeSearchResults.appendChild(button);
    }
  }

  function toggleArmed(field: 'start' | 'end'): void {
    showError(null);
    setArmed(armedField === field ? null : field);
  }

  /** Expands/collapses the bottom control panel so the map can take up more of the screen. */
  function setPanelCollapsed(collapsed: boolean): void {
    panelCollapsed = collapsed;
    panel.classList.toggle('collapsed', collapsed);
    panelToggle.setAttribute('aria-expanded', String(!collapsed));
    panelToggle.setAttribute('aria-label', collapsed ? 'パネルを開く' : 'パネルを折りたたむ');
  }

  /** Expands/collapses the start/end input card so the map can take up more of the screen. */
  function setRouteInputsCollapsed(collapsed: boolean): void {
    routeInputsCollapsed = collapsed;
    routeInputs.classList.toggle('collapsed', collapsed);
    routeInputsToggle.setAttribute('aria-expanded', String(!collapsed));
    routeInputsToggle.setAttribute('aria-label', collapsed ? '出発地・目的地入力を開く' : '出発地・目的地入力を折りたたむ');
    routeInputsToggle.textContent = collapsed ? '﹀' : '︿';
  }

  function updateRouteButtonState(): void {
    routeButton.disabled = !(startInfo && endInfo);
  }

  /** Applies the currently-selected 地上/地下 mode to the map: switches the tile/roads/shadow
   *  layers via setUndergroundMode, and fades every rendered route-line segment that's on the
   *  "wrong side" for the current mode - surface segments while 地下 is selected (kept faintly
   *  visible for continuity, not hidden), nothing while 地上 is selected. Exit/start/end/
   *  current-location markers are never touched here - they stay fully visible in both modes
   *  (see renderExitMarkers in map.ts). */
  function applyUndergroundDisplay(): void {
    setUndergroundMode(layers, undergroundSelected);
    for (const segment of routeSegments) {
      setRouteSegmentDimmed(segment.polyline, undergroundSelected && !segment.indoorOrUnderground);
    }
  }

  function updateFloorToggleLabel(): void {
    floorToggleButton.textContent = undergroundSelected ? '地下' : '地上';
  }

  /** Hides the 地上/地下 toggle button and resets its internal state + display back to normal
   *  (地上). Called whenever the route it was derived from goes away (start/end changed, reset,
   *  or a route recomputation that's about to rebuild it from scratch) - mirrors how
   *  invalidateComputedRoute/resetSelection already clear the other route-dependent UI. */
  function hideFloorToggle(): void {
    undergroundToggleVisible = false;
    undergroundSelected = false;
    routeSegments = [];
    floorToggleButton.hidden = true;
    setUndergroundMode(layers, false);
  }

  /** Shows the toggle button for a newly-computed route, but only if it actually crosses
   *  between surface and indoor/underground (both true and false indoorOrUnderground segments
   *  present) - a route that's entirely one or the other has nothing to toggle. Always
   *  defaults to "地上" - the user actively taps to step into the dimmed underground-focused
   *  view, not the other way around (see plan decision). */
  function showFloorToggle(segments: RouteRenderSegment[]): void {
    routeSegments = segments;
    undergroundSelected = false;
    const hasSurface = segments.some((s) => !s.indoorOrUnderground);
    const hasUnderground = segments.some((s) => s.indoorOrUnderground);
    undergroundToggleVisible = hasSurface && hasUnderground;
    floorToggleButton.hidden = !undergroundToggleVisible;
    updateFloorToggleLabel();
    applyUndergroundDisplay();
  }

  function getSelectedDate(): Date {
    const [y, m, d] = dateInput.value.split('-').map((v) => parseInt(v, 10));
    const hour = parseInt(hourSlider.value, 10);
    return new Date(y, (m || 1) - 1, d || 1, hour, 0, 0, 0);
  }

  function recomputeShadows(): void {
    const date = getSelectedDate();
    const { shadows: buildingShadows, sun } = computeShadows(buildings, date, OTEMACHI_CENTER[0], OTEMACHI_CENTER[1]);
    const { shadows: treeShadows } = computeTreeShadows(trees, date, OTEMACHI_CENTER[0], OTEMACHI_CENTER[1]);
    currentShadows = [...buildingShadows, ...treeShadows];
    currentSun = sun;

    if (!sun.isDaylight) {
      sunInfo.textContent = `太陽高度: ${sun.altitudeDeg.toFixed(1)}° (日没後/日の出前のため影なし)`;
    } else {
      sunInfo.textContent = `太陽高度: ${sun.altitudeDeg.toFixed(1)}° / 方位角: ${sun.azimuthDeg.toFixed(1)}°`;
    }

    if (hasComputedRoute && startInfo && endInfo) {
      runRouteCalculation();
    } else {
      layers.shadowLayer.clearLayers();
    }
  }

  /** Clears a stale computed route/shadow display after start or end changes. */
  function invalidateComputedRoute(): void {
    if (!hasComputedRoute) return;
    layers.shortestRouteLayer.clearLayers();
    layers.shadedRouteLayer.clearLayers();
    layers.shadowLayer.clearLayers();
    layers.exitMarkerLayer.clearLayers();
    resultPanel.hidden = true;
    resultPanel.innerHTML = '';
    hasComputedRoute = false;
    hideFloorToggle();
  }

  function setStart(info: PointInfo): void {
    startInfo = info;
    if (startMarker) layers.markerLayer.removeLayer(startMarker);
    startMarker = renderMarker(layers.markerLayer, 'start', info.lat, info.lon);
    invalidateComputedRoute();
    updateFieldDisplays();
    updateRouteButtonState();
  }

  function setEnd(info: PointInfo): void {
    endInfo = info;
    if (endMarker) layers.markerLayer.removeLayer(endMarker);
    endMarker = renderMarker(layers.markerLayer, 'end', info.lat, info.lon);
    invalidateComputedRoute();
    updateFieldDisplays();
    updateRouteButtonState();
  }

  function clearStart(): void {
    if (!startInfo) return;
    startInfo = null;
    if (startMarker) {
      layers.markerLayer.removeLayer(startMarker);
      startMarker = null;
    }
    invalidateComputedRoute();
    updateFieldDisplays();
    updateRouteButtonState();
  }

  function clearEnd(): void {
    if (!endInfo) return;
    endInfo = null;
    if (endMarker) {
      layers.markerLayer.removeLayer(endMarker);
      endMarker = null;
    }
    invalidateComputedRoute();
    updateFieldDisplays();
    updateRouteButtonState();
  }

  function resetSelection(): void {
    workingGraph = baseGraph.clone();
    startInfo = null;
    endInfo = null;
    startMarker = null;
    endMarker = null;
    hasComputedRoute = false;
    layers.markerLayer.clearLayers();
    layers.shortestRouteLayer.clearLayers();
    layers.shadedRouteLayer.clearLayers();
    layers.shadowLayer.clearLayers();
    layers.exitMarkerLayer.clearLayers();
    resultPanel.hidden = true;
    resultPanel.innerHTML = '';
    hideFloorToggle();
    setArmed(null);
    updateFieldDisplays();
    updateRouteButtonState();
    showError(null);
  }

  /** Shared confirm path for both a map tap and a search-result tap: snaps the given
   *  point onto the road network, sets it as the armed field's start/end, and disarms.
   *  No-op if no field is currently armed. `label` (place name) is only passed for
   *  search-result taps; map taps leave it unset so the field falls back to coordinates. */
  function confirmSelectionAt(lat: number, lon: number, label?: string): void {
    if (!armedField) return;

    showError(null);
    const snapped = workingGraph.snapToNetwork(lat, lon);
    if (!snapped) {
      showError('近くに道路が見つかりませんでした。別の場所を選択してください。');
      return;
    }

    const info: PointInfo = { nodeId: snapped.nodeId, lat: snapped.lat, lon: snapped.lon, label };
    if (armedField === 'start') {
      setStart(info);
    } else {
      setEnd(info);
    }
    setArmed(null);
  }

  function handleMapClick(latlng: L.LatLng): void {
    // Map taps are no-ops unless the user has explicitly armed the start or end field -
    // this is what prevents an accidental/unrelated tap from silently discarding a
    // previously computed route.
    if (!armedField) return;
    confirmSelectionAt(latlng.lat, latlng.lng);
  }

  /** Finds the nearest subway/station-entrance place (one with a `ref`, e.g. "B4") within
   *  NEAREST_EXIT_MAX_DISTANCE_M of (lat, lon), if any. Used to surface "最寄り出口: <name>
   *  <ref>" next to the start/end point in the result panel. */
  function findNearestExit(lat: number, lon: number): { name: string; ref: string } | null {
    const point = L.latLng(lat, lon);
    let best: { name: string; ref: string; dist: number } | null = null;
    for (const feature of places.features) {
      const ref = feature.properties.ref;
      if (!ref) continue;
      const dist = point.distanceTo(L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]));
      if (dist <= NEAREST_EXIT_MAX_DISTANCE_M && (!best || dist < best.dist)) {
        best = { name: feature.properties.name, ref, dist };
      }
    }
    return best ? { name: best.name, ref: best.ref } : null;
  }

  /** Tighter than NEAREST_EXIT_MAX_DISTANCE_M (40m): a layer-transition boundary is one exact
   *  coordinate (not a whole edge's length), so "an entrance sits right at this transition"
   *  should read as a stricter match than "an entrance is somewhere near this edge". 25m
   *  leaves room for the entrance point and the route's snapped-to-network path not
   *  perfectly coinciding (they're digitized independently in the source OSM data), while
   *  staying well short of 40m, which is loose enough to catch unrelated entrances that
   *  merely happen to be near a point the route passes through without any real transition
   *  there - exactly the over-broad-matching problem this replaces. */
  const TRANSITION_EXIT_MAX_DISTANCE_M = 25;

  /** One layer-transition boundary in a route's edges: the coordinate ([lon, lat]) it occurs
   *  at. Used to find where an exit marker should be shown (see findExitsAtTransitions) - not
   *  tied to the 地上/地下 toggle's own (simpler, indoorOrUnderground-based) show/hide check. */
  interface LayerTransition {
    coord: [number, number];
  }

  /** Every layer-transition boundary in one route's edges, in order: the point where
   *  consecutive edges' `layer` values differ is the shared vertex edges[i-1].coords[1] ===
   *  edges[i].coords[0] (edges are ordered start-to-end with matching from/to geometry - see
   *  graph.ts's addSegment/splitEdgeAt). */
  function findLayerTransitions(edges: GraphEdge[]): LayerTransition[] {
    const transitions: LayerTransition[] = [];
    for (let i = 1; i < edges.length; i++) {
      if (edges[i - 1].layer !== edges[i].layer) {
        transitions.push({ coord: edges[i].coords[0] });
      }
    }
    return transitions;
  }

  /** Returns the subset of ref-bearing entrance features (places.geojson) that sit within
   *  TRANSITION_EXIT_MAX_DISTANCE_M of a genuine floor-transition point on the given routes
   *  (shortest and shaded, kept separate so a boundary is never spuriously detected at the
   *  seam between the two routes' edge lists) - these are always rendered at full visibility
   *  (see renderExitMarkers in map.ts), regardless of the 地上/地下 toggle's selection. Unlike
   *  the previous "any edge, 40m" version, a route that never changes layer produces zero
   *  transitions and therefore zero markers - points merely near the route with no floor
   *  change there are correctly excluded. Only the nearest ref-bearing feature per transition
   *  point is taken (mirrors findNearestExit's "closest wins" behavior); a feature matched
   *  from more than one transition point is still only rendered once. */
  function findExitsAtTransitions(edgeLists: GraphEdge[][]): PlacesFeatureCollection['features'] {
    const transitionPoints: L.LatLng[] = [];
    for (const edges of edgeLists) {
      for (const transition of findLayerTransitions(edges)) {
        const [lon, lat] = transition.coord;
        transitionPoints.push(L.latLng(lat, lon));
      }
    }
    if (transitionPoints.length === 0) return [];

    const matched = new Set<PlacesFeatureCollection['features'][number]>();
    for (const point of transitionPoints) {
      let best: { feature: PlacesFeatureCollection['features'][number]; dist: number } | null = null;
      for (const feature of places.features) {
        if (!feature.properties.ref) continue;
        const dist = point.distanceTo(L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]));
        if (dist <= TRANSITION_EXIT_MAX_DISTANCE_M && (!best || dist < best.dist)) {
          best = { feature, dist };
        }
      }
      if (best) matched.add(best.feature);
    }
    return [...matched];
  }

  function formatNearestExitLine(label: string, point: PointInfo): string {
    const exit = findNearestExit(point.lat, point.lon);
    if (!exit) return '';
    return `<div class="result-exit">${label}の最寄り出口: ${escapeHtml(exit.name)} ${escapeHtml(exit.ref)}</div>`;
  }

  function formatRouteStats(label: string, route: RouteResult | null): string {
    if (!route) {
      return `<div class="result-item"><strong>${label}</strong>: ルートが見つかりませんでした</div>`;
    }
    const pct = (route.shadeRatio * 100).toFixed(0);
    return `<div class="result-item"><strong>${label}</strong>: ${route.distanceMeters.toFixed(0)} m / 日陰率 ${pct}%</div>`;
  }

  function runRouteCalculation(): void {
    if (!startInfo || !endInfo) {
      showError('出発地と目的地を両方タップしてください。');
      return;
    }
    showError(null);

    // Built once and shared with findShadowsAlongEdges below - both operate over the same
    // currentShadows set, so there's no need to re-index them separately.
    const shadowIndex = buildShadowGridIndex(currentShadows);
    const shadeFractions = computeEdgeShadeFractions(workingGraph, currentShadows, shadowIndex);
    // No sun at all (night) means no edge can be in direct sunlight, so edges missing from
    // shadeFractions (i.e. all of them, since shadows.length === 0 then) should read as fully
    // shaded rather than the daytime default of fully sunny.
    const defaultFraction = currentSun && !currentSun.isDaylight ? 1 : 0;
    const { shortest, shaded } = computeRoutes(workingGraph, startInfo.nodeId, endInfo.nodeId, shadeFractions, defaultFraction);

    if (!shortest && !shaded) {
      showError('出発地と目的地の間にルートが見つかりませんでした。');
      layers.shortestRouteLayer.clearLayers();
      layers.shadedRouteLayer.clearLayers();
      layers.shadowLayer.clearLayers();
      layers.exitMarkerLayer.clearLayers();
      resultPanel.hidden = true;
      hideFloorToggle();
      return;
    }

    const shortestSegments = renderRoute(layers.shortestRouteLayer, shortest, '#c62828');
    const shadedSegments = renderRoute(layers.shadedRouteLayer, shaded, '#1565c0');

    const routeEdges = [...(shortest?.edges ?? []), ...(shaded?.edges ?? [])];
    const relevantShadows = findShadowsAlongEdges(routeEdges, currentShadows, shadowIndex);
    renderShadows(layers, relevantShadows);
    renderExitMarkers(layers.exitMarkerLayer, findExitsAtTransitions([shortest?.edges ?? [], shaded?.edges ?? []]));

    // Every (re)computation - including a same-endpoints recompute triggered by a date/time
    // change via recomputeShadows() - starts the toggle fresh at 地上 rather than carrying
    // over whatever mode was selected on a previous route.
    showFloorToggle([...shortestSegments, ...shadedSegments]);

    const exitLines = formatNearestExitLine('出発地', startInfo) + formatNearestExitLine('目的地', endInfo);

    resultPanel.hidden = false;
    resultPanel.innerHTML = formatRouteStats('日陰優先ルート', shaded) + formatRouteStats('最短距離ルート', shortest) + exitLines;
    hasComputedRoute = true;
  }

  /** Re-renders the armed field's search results so the "use current location" option
   *  appears/disappears immediately as a GPS fix arrives or tracking stops, without
   *  discarding whatever the user has already typed. */
  function refreshArmedSearchResults(): void {
    if (!armedField) return;
    const input = armedField === 'start' ? fieldStartInput : fieldEndInput;
    renderSearchResults(input.value);
  }

  function setLocateState(state: LocateState): void {
    locateState = state;
    locateButton.dataset.state = state;
    const labels: Record<LocateState, string> = {
      off: '現在地を表示',
      following: '現在地に追従中',
      trackingNotFollowing: '現在地に戻る',
    };
    locateButton.setAttribute('aria-label', labels[state]);
  }

  /** Position-update handler for the live GPS watch. Deliberately narrow: it only ever
   *  touches the current-location marker and (while following) the map's pan position -
   *  never the route/graph/shade state. Moving GPS position must never trigger a
   *  route recalculation, even if a route is already on screen. */
  function handlePositionUpdate(position: GeolocationPosition): void {
    currentPosition = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      accuracy: position.coords.accuracy,
      source: 'gps',
    };
    renderCurrentLocation(layers.currentLocationLayer, currentPosition.lat, currentPosition.lon, currentPosition.accuracy);
    if (locateState === 'following') {
      // panTo (like setView) is programmatic and never fires Leaflet's 'dragstart' event,
      // which is what lets the dragstart listener below reliably tell "map moved because
      // we're following GPS" apart from "map moved because the user dragged it".
      layers.map.panTo([currentPosition.lat, currentPosition.lon]);
    }
    refreshArmedSearchResults();
  }

  function handlePositionError(err: GeolocationPositionError): void {
    const messages: Record<number, string> = {
      1: '位置情報の利用が許可されていません。端末の設定を確認してください。',
      2: '現在地を取得できませんでした。電波状況を確認してください。',
      3: '現在地の取得がタイムアウトしました。',
    };
    showError(messages[err.code] ?? '現在地を取得できませんでした。');
    stopTracking();
  }

  function stopTracking(): void {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    currentPosition = null;
    layers.currentLocationLayer.clearLayers();
    setLocateState('off');
    refreshArmedSearchResults();
  }

  function startTracking(): void {
    if (!('geolocation' in navigator)) {
      showError('この端末は位置情報の取得に対応していません。');
      return;
    }
    showError(null);
    // following is set before the first fix arrives (not after) so that fix's own
    // handlePositionUpdate call - which centers the map only when locateState is
    // 'following' - performs the required "center on first fix" behavior with no
    // separate first-fix special case.
    setLocateState('following');
    watchId = navigator.geolocation.watchPosition(handlePositionUpdate, handlePositionError, {
      enableHighAccuracy: true,
    });
  }

  locateButton.addEventListener('click', (e: MouseEvent) => {
    // The button lives inside the Leaflet map container (so it can be positioned/sized
    // relative to the actual map viewport), so without this the click would also bubble
    // up to the map's own 'click' handler and be misread as a map-tap point selection.
    e.stopPropagation();
    if (locateState === 'off') {
      startTracking();
      return;
    }
    // following or trackingNotFollowing: re-center on the latest known fix and
    // (re-)transition to following.
    if (currentPosition) {
      layers.map.panTo([currentPosition.lat, currentPosition.lon]);
    }
    setLocateState('following');
  });

  layers.map.on('dragstart', () => {
    // dragstart only fires for user-initiated dragging, never for the programmatic
    // panTo/setView calls used above - so this is a reliable "the user took the map back"
    // signal, unlike a generic movestart/moveend listener which would fire for both.
    if (locateState === 'following') {
      setLocateState('trackingNotFollowing');
    }
  });

  floorToggleButton.addEventListener('click', (e: MouseEvent) => {
    // Same reasoning as locateButton above: this button lives inside the map container, so
    // without this the tap would also bubble up as a map-click and get misread as a
    // start/end point selection.
    e.stopPropagation();
    if (!undergroundToggleVisible) return;
    undergroundSelected = !undergroundSelected;
    updateFloorToggleLabel();
    applyUndergroundDisplay();
  });

  // ---- wire up events ----
  layers.map.on('click', (e: L.LeafletMouseEvent) => handleMapClick(e.latlng));

  dateInput.addEventListener('change', recomputeShadows);
  hourSlider.addEventListener('input', () => {
    hourValue.textContent = `${hourSlider.value.padStart(2, '0')}:00`;
  });
  hourSlider.addEventListener('change', recomputeShadows);

  nowButton.addEventListener('click', () => {
    const rounded = roundHourDate(new Date());
    dateInput.value = formatDateInput(rounded);
    hourSlider.value = String(rounded.getHours());
    hourValue.textContent = `${String(rounded.getHours()).padStart(2, '0')}:00`;
    recomputeShadows();
  });

  resetButton.addEventListener('click', resetSelection);
  routeButton.addEventListener('click', runRouteCalculation);

  fieldStart.addEventListener('click', () => toggleArmed('start'));
  fieldStart.addEventListener('keydown', (e: KeyboardEvent) => {
    // Ignore keydowns that bubbled up from the clear button - otherwise Enter/Space on
    // the clear button would both trigger its click handler AND re-arm this field.
    if (e.target !== fieldStart) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleArmed('start');
    }
  });
  fieldEnd.addEventListener('click', () => toggleArmed('end'));
  fieldEnd.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.target !== fieldEnd) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleArmed('end');
    }
  });

  // Clicking into the input (e.g. to reposition the cursor while typing) would otherwise
  // bubble up to the field's own click listener above and immediately re-toggle (disarm)
  // the field the user is actively typing into - same guard the clear button uses below.
  fieldStartInput.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
  fieldEndInput.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
  fieldStartInput.addEventListener('input', () => {
    renderSearchResults(fieldStartInput.value);
  });
  fieldEndInput.addEventListener('input', () => {
    renderSearchResults(fieldEndInput.value);
  });

  clearStartButton.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    clearStart();
  });
  clearEndButton.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    clearEnd();
  });

  panelToggle.addEventListener('click', () => setPanelCollapsed(!panelCollapsed));

  routeInputsToggle.addEventListener('click', () => {
    // Collapsing the card hides the "tap map to select" hint, so disarm any pending
    // start/end selection first to avoid a hint-less armed state lingering underneath.
    if (armedField) setArmed(null);
    setRouteInputsCollapsed(!routeInputsCollapsed);
  });

  // ---- initial state ----
  const initialDate = roundHourDate(new Date());
  dateInput.value = formatDateInput(initialDate);
  hourSlider.value = String(initialDate.getHours());
  hourValue.textContent = `${String(initialDate.getHours()).padStart(2, '0')}:00`;

  setArmed(null);
  updateFieldDisplays();
  updateRouteButtonState();
  setPanelCollapsed(false);
  setRouteInputsCollapsed(false);
  setLocateState('off');
  recomputeShadows();
}
