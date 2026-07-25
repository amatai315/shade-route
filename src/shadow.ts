// Computes simplified building-shadow polygons for a given date/time using
// SunCalc for solar position and Turf for geometry (destination projection + convex hull).

import SunCalc from 'suncalc';
import * as turf from '@turf/turf';
import type { Feature, Polygon } from 'geojson';
import type { SunState } from './types';

export interface BuildingsFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Polygon'; coordinates: number[][][] };
    properties: { height: number; id: string };
  }>;
}

/** GeoJSON FeatureCollection of street trees, as loaded from data/trees.geojson. */
export interface TreesFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { id: string; species: string; height: number; crownDiameter: number };
  }>;
}

export interface ShadowPolygon {
  buildingId: string;
  polygon: Feature<Polygon>;
}

/** Reads current sun altitude/azimuth (in degrees) for the given date+time and location. */
export function getSunState(date: Date, lat: number, lon: number): SunState {
  const pos = SunCalc.getPosition(date, lat, lon);
  const altitudeDeg = (pos.altitude * 180) / Math.PI;
  const azimuthDeg = (pos.azimuth * 180) / Math.PI;
  return {
    altitudeDeg,
    azimuthDeg,
    isDaylight: altitudeDeg > 0,
  };
}

/**
 * Converts SunCalc's azimuth (radians, 0 = south, positive = towards west) into the
 * compass bearing (degrees, 0 = north, clockwise) that the shadow is cast towards
 * (i.e. directly away from the sun).
 *
 * Derivation: compass bearing of the SUN = 180 + azimuthDeg (since azimuth 0 = south = bearing 180).
 * The shadow points the opposite way: shadowBearing = sunBearing + 180 = azimuthDeg (mod 360).
 */
function shadowBearingDeg(azimuthDeg: number): number {
  let bearing = azimuthDeg % 360;
  if (bearing < 0) bearing += 360;
  // turf.destination expects bearing in (-180, 180]; normalize.
  if (bearing > 180) bearing -= 360;
  return bearing;
}

/**
 * Projects every footprint vertex `shadowLength` meters away from the sun (in `bearing`
 * direction), then takes the convex hull of the original + projected vertices. Shared by
 * the building and tree-canopy shadow paths below, since neither cares what shape the
 * source footprint is - only that it's a ring of [lon, lat] vertices.
 */
function projectFootprintShadow(
  ring: [number, number][],
  shadowLength: number,
  bearing: number
): Feature<Polygon> | null {
  const points: [number, number][] = [];
  for (const [lon0, lat0] of ring) {
    points.push([lon0, lat0]);
    const projected = turf.destination([lon0, lat0], shadowLength, bearing, { units: 'meters' });
    points.push(projected.geometry.coordinates as [number, number]);
  }

  try {
    const fc = turf.featureCollection(points.map((p) => turf.point(p)));
    return turf.convex(fc);
  } catch {
    // degenerate geometry (e.g. collinear points) - no shadow for this footprint
    return null;
  }
}

/**
 * Builds one simplified shadow polygon per building: projects every footprint vertex
 * `height / tan(altitude)` meters away from the sun, then takes the convex hull of the
 * original + projected vertices. Returns an empty array when the sun is at/below the horizon.
 */
export function computeShadows(
  buildings: BuildingsFeatureCollection,
  date: Date,
  lat: number,
  lon: number
): { shadows: ShadowPolygon[]; sun: SunState } {
  const sun = getSunState(date, lat, lon);
  if (!sun.isDaylight) {
    return { shadows: [], sun };
  }

  const altitudeRad = (sun.altitudeDeg * Math.PI) / 180;
  const bearing = shadowBearingDeg(sun.azimuthDeg);
  const shadows: ShadowPolygon[] = [];

  for (const feature of buildings.features) {
    const height = feature.properties.height;
    const shadowLength = height / Math.tan(altitudeRad);
    if (!isFinite(shadowLength) || shadowLength <= 0) continue;

    const ring = feature.geometry.coordinates[0] as [number, number][]; // exterior ring, [lon, lat][]
    const hull = projectFootprintShadow(ring, shadowLength, bearing);
    if (hull) {
      shadows.push({ buildingId: feature.properties.id, polygon: hull });
    }
  }

  return { shadows, sun };
}

/**
 * Builds one simplified shadow polygon per street tree, using the same vertex-projection +
 * convex-hull approach as computeShadows. Each tree's canopy footprint is approximated as a
 * 12-sided polygon centered on the tree's point location, with radius = crownDiameter / 2
 * (crownDiameter is a diameter, not a radius). Returns an empty array when the sun is at/below
 * the horizon.
 */
export function computeTreeShadows(
  trees: TreesFeatureCollection,
  date: Date,
  lat: number,
  lon: number
): { shadows: ShadowPolygon[]; sun: SunState } {
  const sun = getSunState(date, lat, lon);
  if (!sun.isDaylight) {
    return { shadows: [], sun };
  }

  const altitudeRad = (sun.altitudeDeg * Math.PI) / 180;
  const bearing = shadowBearingDeg(sun.azimuthDeg);
  const shadows: ShadowPolygon[] = [];

  for (const feature of trees.features) {
    const { height, crownDiameter, id } = feature.properties;
    const shadowLength = height / Math.tan(altitudeRad);
    if (!isFinite(shadowLength) || shadowLength <= 0) continue;

    const canopyRadius = crownDiameter / 2;
    if (!isFinite(canopyRadius) || canopyRadius <= 0) continue;

    const canopy = turf.circle(feature.geometry.coordinates, canopyRadius, {
      steps: 12,
      units: 'meters',
    });
    const ring = canopy.geometry.coordinates[0] as [number, number][];
    const hull = projectFootprintShadow(ring, shadowLength, bearing);
    if (hull) {
      shadows.push({ buildingId: id, polygon: hull });
    }
  }

  return { shadows, sun };
}
