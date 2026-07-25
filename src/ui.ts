// UI wiring: control panel state, map tap handling, and orchestration of the
// shadow / graph / route modules.

import L from 'leaflet';
import { OTEMACHI_CENTER, renderMarker, renderRoute, renderShadows, type MapLayers } from './map';
import { RoadGraph } from './graph';
import {
  computeShadows,
  computeTreeShadows,
  type BuildingsFeatureCollection,
  type ShadowPolygon,
  type TreesFeatureCollection,
} from './shadow';
import { buildShadowGridIndex, computeEdgeShadeFractions, computeRoutes, findShadowsAlongEdges } from './route';
import type { PlacesFeatureCollection, RouteResult } from './types';

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

/** Which of the two input fields (if any) is currently waiting for the next map tap. */
type ArmedField = 'start' | 'end' | null;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
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

  legend.innerHTML = `
    <div class="legend-item"><span class="swatch swatch-shaded"></span>日陰優先ルート</div>
    <div class="legend-item"><span class="swatch swatch-shortest"></span>最短距離ルート</div>
    <div class="legend-item"><span class="swatch swatch-shadow"></span>建物・街路樹の影</div>
  `;

  // ---- state ----
  let armedField: ArmedField = null;
  let workingGraph: RoadGraph = baseGraph.clone();
  let startInfo: PointInfo | null = null;
  let endInfo: PointInfo | null = null;
  let startMarker: L.CircleMarker | null = null;
  let endMarker: L.CircleMarker | null = null;
  let currentShadows: ShadowPolygon[] = [];
  let hasComputedRoute = false;
  let panelCollapsed = false;
  let routeInputsCollapsed = false;

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
    routeSearchResults.hidden = !field;
    routeSearchResults.innerHTML = '';
  }

  /** Renders up to MAX_SEARCH_RESULTS places matching `query` (case-insensitive substring),
   *  nearest-to-map-center first. Each result is a button that runs the same confirm path
   *  as a map tap. */
  function renderSearchResults(query: string): void {
    routeSearchResults.innerHTML = '';
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
    resultPanel.hidden = true;
    resultPanel.innerHTML = '';
    hasComputedRoute = false;
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
    resultPanel.hidden = true;
    resultPanel.innerHTML = '';
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
    const { shortest, shaded } = computeRoutes(workingGraph, startInfo.nodeId, endInfo.nodeId, shadeFractions);

    if (!shortest && !shaded) {
      showError('出発地と目的地の間にルートが見つかりませんでした。');
      layers.shortestRouteLayer.clearLayers();
      layers.shadedRouteLayer.clearLayers();
      layers.shadowLayer.clearLayers();
      resultPanel.hidden = true;
      return;
    }

    renderRoute(layers.shortestRouteLayer, shortest, '#c62828');
    renderRoute(layers.shadedRouteLayer, shaded, '#1565c0');

    const routeEdges = [...(shortest?.edges ?? []), ...(shaded?.edges ?? [])];
    const relevantShadows = findShadowsAlongEdges(routeEdges, currentShadows, shadowIndex);
    renderShadows(layers, relevantShadows);

    resultPanel.hidden = false;
    resultPanel.innerHTML = formatRouteStats('日陰優先ルート', shaded) + formatRouteStats('最短距離ルート', shortest);
    hasComputedRoute = true;
  }

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
  recomputeShadows();
}
