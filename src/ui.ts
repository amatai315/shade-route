// UI wiring: control panel state, map tap handling, and orchestration of the
// shadow / graph / route modules.

import type L from 'leaflet';
import { OTEMACHI_CENTER, renderMarker, renderRoute, renderShadows, type MapLayers } from './map';
import { RoadGraph } from './graph';
import { computeShadows, type BuildingsFeatureCollection, type ShadowPolygon } from './shadow';
import { computeEdgeShadeFractions, computeRoutes, findShadowsAlongEdges } from './route';
import type { RouteResult, TapState } from './types';

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
  const statusStart = byId<HTMLSpanElement>('status-start');
  const statusEnd = byId<HTMLSpanElement>('status-end');
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
  let tapState: TapState = 'none';
  let workingGraph: RoadGraph = baseGraph.clone();
  let startInfo: PointInfo | null = null;
  let endInfo: PointInfo | null = null;
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

  function updateStatusChips(): void {
    statusStart.textContent = startInfo
      ? `出発地: ${startInfo.lat.toFixed(5)}, ${startInfo.lon.toFixed(5)}`
      : '出発地: 未設定';
    statusEnd.textContent = endInfo
      ? `目的地: ${endInfo.lat.toFixed(5)}, ${endInfo.lon.toFixed(5)}`
      : '目的地: 未設定';
    statusStart.classList.toggle('chip-active', !!startInfo);
    statusEnd.classList.toggle('chip-active', !!endInfo);
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

  function resetSelection(): void {
    tapState = 'none';
    startInfo = null;
    endInfo = null;
    hasComputedRoute = false;
    workingGraph = baseGraph.clone();
    layers.markerLayer.clearLayers();
    layers.shortestRouteLayer.clearLayers();
    layers.shadedRouteLayer.clearLayers();
    layers.shadowLayer.clearLayers();
    resultPanel.hidden = true;
    resultPanel.innerHTML = '';
    updateStatusChips();
    updateRouteButtonState();
    showError(null);
  }

  function handleMapClick(latlng: L.LatLng): void {
    showError(null);
    if (tapState === 'both-set') {
      resetSelection();
    }

    const snapped = workingGraph.snapToNetwork(latlng.lat, latlng.lng);
    if (!snapped) {
      showError('近くに道路が見つかりませんでした。別の場所をタップしてください。');
      return;
    }

    if (tapState === 'none') {
      startInfo = { nodeId: snapped.nodeId, lat: snapped.lat, lon: snapped.lon };
      renderMarker(layers.markerLayer, 'start', snapped.lat, snapped.lon);
      tapState = 'start-set';
    } else if (tapState === 'start-set') {
      endInfo = { nodeId: snapped.nodeId, lat: snapped.lat, lon: snapped.lon };
      renderMarker(layers.markerLayer, 'end', snapped.lat, snapped.lon);
      tapState = 'both-set';
    }

    updateStatusChips();
    updateRouteButtonState();
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

    const shadeFractions = computeEdgeShadeFractions(workingGraph, currentShadows);
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
    const relevantShadows = findShadowsAlongEdges(routeEdges, currentShadows);
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

  // ---- initial state ----
  const initialDate = roundHourDate(new Date());
  dateInput.value = formatDateInput(initialDate);
  hourSlider.value = String(initialDate.getHours());
  hourValue.textContent = `${String(initialDate.getHours()).padStart(2, '0')}:00`;

  updateStatusChips();
  updateRouteButtonState();
  recomputeShadows();
}
