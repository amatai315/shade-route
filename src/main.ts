import './style.css';
import { initMap, renderExitMarkers, renderRoads } from './map';
import { buildGraphFromRoads } from './graph';
import { startApp } from './ui';
import type { BuildingsFeatureCollection, TreesFeatureCollection } from './shadow';
import type { PlacesFeatureCollection, RoadsFeatureCollection } from './types';

async function loadJson<T>(path: string): Promise<T> {
  const url = `${import.meta.env.BASE_URL}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to load ${url}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function bootstrap(): Promise<void> {
  const layers = initMap('map');

  try {
    const [roads, buildings, trees, places] = await Promise.all([
      loadJson<RoadsFeatureCollection>('data/roads.geojson'),
      loadJson<BuildingsFeatureCollection>('data/buildings.geojson'),
      loadJson<TreesFeatureCollection>('data/trees.geojson'),
      loadJson<PlacesFeatureCollection>('data/places.geojson'),
    ]);

    renderRoads(layers, roads as unknown as GeoJSON.FeatureCollection);
    // Exit markers are static wayfinding infrastructure, not route-relevant like the
    // shadow layer - rendered once at startup as a permanent layer, same as the roads.
    renderExitMarkers(layers.exitMarkerLayer, places);
    const graph = buildGraphFromRoads(roads);
    startApp(graph, buildings, trees, places, layers);
  } catch (err) {
    const sunInfo = document.getElementById('sun-info');
    if (sunInfo) {
      sunInfo.textContent = 'データの読み込みに失敗しました。ページを再読み込みしてください。';
    }
    console.error(err);
  }
}

bootstrap();
