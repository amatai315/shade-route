// UI wiring: control panel state, map tap handling, and orchestration of the
// shadow / graph / route modules.

import type L from 'leaflet';
import { OTEMACHI_CENTER, renderMarker, renderRoute, renderShadows, type MapLayers } from './map';
import { RoadGraph } from './graph';
import { computeShadows, type BuildingsFeatureCollection, type ShadowPolygon } from './shadow';
import { buildShadowGridIndex, computeEdgeShadeFractions, computeRoutes, findShadowsAlongEdges } from './route';
import type { RouteResult } from './types';

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
  const clearStartButton = byId<HTMLButtonElement>('clear-start');
  const clearEndButton = byId<HTMLButtonElement>('clear-end');
  const routeHint = byId<HTMLDivElement>('route-hint');
  const sunInfo = byId<HTMLDivElement>('sun-info');
  const errorMessage = byId<HTMLDivElement>('error-message');
  const resultPanel = byId<HTMLDivElement>('result-panel');
  const legend = byId<HTMLDivElement>('legend');

  legend.innerHTML = `
    <div class="legend-item"><span class="swatch swatch-shaded"></span>日陰優先ルート</div>
    <div class="legend-item"><span class="swatch swatch-shortest"></span>最短距離ルート</div>
    <div class="legend-item"><span class="swatch swatch-shadow"></span>建物の影</div>
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
      fieldStartText.textContent = `${startInfo.lat.toFixed(5)}, ${startInfo.lon.toFixed(5)}`;
      fieldStart.classList.add('field-set');
      clearStartButton.hidden = false;
    } else {
      fieldStartText.textContent = 'タップして地図で選択';
      fieldStart.classList.remove('field-set');
      clearStartButton.hidden = true;
    }
    if (endInfo) {
      fieldEndText.textContent = `${endInfo.lat.toFixed(5)}, ${endInfo.lon.toFixed(5)}`;
      fieldEnd.classList.add('field-set');
      clearEndButton.hidden = false;
    } else {
      fieldEndText.textContent = 'タップして地図で選択';
      fieldEnd.classList.remove('field-set');
      clearEndButton.hidden = true;
    }
  }

  /** Arms/disarms a field for the next map tap, updating the highlight + hint text. */
  function setArmed(field: ArmedField): void {
    armedField = field;
    fieldStart.classList.toggle('field-armed', field === 'start');
    fieldEnd.classList.toggle('field-armed', field === 'end');
    if (field === 'start') {
      routeHint.hidden = false;
      routeHint.textContent = '地図をタップして出発地を選択してください';
    } else if (field === 'end') {
      routeHint.hidden = false;
      routeHint.textContent = '地図をタップして目的地を選択してください';
    } else {
      routeHint.hidden = true;
      routeHint.textContent = '';
    }
  }

  function toggleArmed(field: 'start' | 'end'): void {
    showError(null);
    setArmed(armedField === field ? null : field);
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
    const { shadows, sun } = computeShadows(buildings, date, OTEMACHI_CENTER[0], OTEMACHI_CENTER[1]);
    currentShadows = shadows;

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

  function handleMapClick(latlng: L.LatLng): void {
    // Map taps are no-ops unless the user has explicitly armed the start or end field -
    // this is what prevents an accidental/unrelated tap from silently discarding a
    // previously computed route.
    if (!armedField) return;

    showError(null);
    const snapped = workingGraph.snapToNetwork(latlng.lat, latlng.lng);
    if (!snapped) {
      showError('近くに道路が見つかりませんでした。別の場所をタップしてください。');
      return;
    }

    const info: PointInfo = { nodeId: snapped.nodeId, lat: snapped.lat, lon: snapped.lon };
    if (armedField === 'start') {
      setStart(info);
    } else {
      setEnd(info);
    }
    setArmed(null);
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

  clearStartButton.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    clearStart();
  });
  clearEndButton.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    clearEnd();
  });

  // ---- initial state ----
  const initialDate = roundHourDate(new Date());
  dateInput.value = formatDateInput(initialDate);
  hourSlider.value = String(initialDate.getHours());
  hourValue.textContent = `${String(initialDate.getHours()).padStart(2, '0')}:00`;

  setArmed(null);
  updateFieldDisplays();
  updateRouteButtonState();
  recomputeShadows();
}
