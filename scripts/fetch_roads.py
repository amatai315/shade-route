"""
Fetch pedestrian-usable roads within ~1000m of Otemachi station from the
Overpass API and write them out as a GeoJSON FeatureCollection at
public/data/roads.geojson.

The raw Overpass JSON response is cached at scripts/.cache/overpass_raw.json
so this script does not need to hit the network again on re-runs (pass
--refetch to force a new request).

Usage:
    python scripts/fetch_roads.py [--refetch]
"""
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
CACHE_PATH = ROOT_DIR / "scripts" / ".cache" / "overpass_raw.json"
OUT_PATH = ROOT_DIR / "public" / "data" / "roads.geojson"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

CENTER_LAT = 35.6862
CENTER_LON = 139.7671
RADIUS_M = 1050  # Overpass fetch radius - a bit wider buffer than the buildings' 1000m,
# so that ways crossing the target area are captured whole before we clip them
# down to CLIP_RADIUS_M below (Overpass around: includes a whole way if ANY of
# its nodes is within range, so raw results can extend well past RADIUS_M).
CLIP_RADIUS_M = 1000  # final output is clipped so every vertex is within this radius

HIGHWAY_VALUES = [
    "footway",
    "pedestrian",
    "sidewalk",
    "residential",
    "living_street",
    "path",
    "steps",
    "service",
]

QUERY = f"""
[out:json][timeout:180];
(
  way["highway"~"^({'|'.join(HIGHWAY_VALUES)})$"](around:{RADIUS_M},{CENTER_LAT},{CENTER_LON});
);
out geom;
""".strip()


def haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in meters between two lat/lon points."""
    r = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def dist_from_center(lon, lat):
    return haversine_m(CENTER_LAT, CENTER_LON, lat, lon)


def clip_linestring(coords, radius=CLIP_RADIUS_M):
    """Clip a line (list of [lon, lat] pairs) down to the portions that lie
    within `radius` meters of the station center, splitting it into multiple
    segments where it leaves and re-enters the circle.

    For each consecutive vertex pair: if both are within radius, keep the
    segment as-is. If one is within and the other is not, the boundary
    crossing point is found by linearly interpolating between the two
    vertices (in lon/lat space) using the ratio of how far each vertex's
    distance-from-center is from `radius`. Since distance-from-center is a
    convex function along a straight segment, this interpolated point's true
    distance from center is always <= radius (it never overshoots).

    Returns a list of coordinate lists (each with >= 2 points); a single
    input line may produce zero, one, or several output segments.
    """
    if len(coords) < 2:
        return []

    dists = [dist_from_center(lon, lat) for lon, lat in coords]
    segments = []
    current = []

    def flush():
        nonlocal current
        if len(current) >= 2:
            segments.append(current)
        current = []

    for i in range(len(coords) - 1):
        p1, p2 = coords[i], coords[i + 1]
        d1, d2 = dists[i], dists[i + 1]
        in1, in2 = d1 <= radius, d2 <= radius

        if in1:
            if not current or current[-1] != p1:
                current.append(p1)

        if in1 != in2:
            t = (radius - d1) / (d2 - d1)
            t = min(max(t, 0.0), 1.0)
            boundary_pt = [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])]
            if not current or current[-1] != boundary_pt:
                current.append(boundary_pt)
            if not in2:
                flush()
        elif not in1 and not in2:
            # fully outside this sub-segment - nothing to add
            pass

    if dists[-1] <= radius:
        last = coords[-1]
        if not current or current[-1] != last:
            current.append(last)

    flush()
    return segments


def fetch_overpass():
    data = f"data={urllib.parse.quote(QUERY)}".encode("utf-8")
    req = urllib.request.Request(
        OVERPASS_URL,
        data=data,
        headers={
            "User-Agent": "shade-route-poc/1.0",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=200) as resp:
        body = resp.read()
    return json.loads(body)


def main():
    refetch = "--refetch" in sys.argv
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    if CACHE_PATH.exists() and not refetch:
        print(f"Using cached Overpass response: {CACHE_PATH}")
        raw = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    else:
        print("Querying Overpass API ...")
        print(QUERY)
        raw = fetch_overpass()
        CACHE_PATH.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        print(f"Cached raw response to {CACHE_PATH}")

    elements = raw.get("elements", [])
    print(f"Overpass returned {len(elements)} elements")

    features = []
    highway_counts = {}
    for el in elements:
        if el.get("type") != "way":
            continue
        geometry = el.get("geometry")
        if not geometry:
            continue
        tags = el.get("tags", {})
        highway = tags.get("highway", "unknown")
        coords = [[pt["lon"], pt["lat"]] for pt in geometry]
        if len(coords) < 2:
            continue
        for segment in clip_linestring(coords):
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": segment,
                    },
                    "properties": {
                        "highway": highway,
                        "id": el.get("id"),
                    },
                }
            )
            highway_counts[highway] = highway_counts.get(highway, 0) + 1

    fc = {
        "type": "FeatureCollection",
        "features": features,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)

    print(f"Wrote {len(features)} road features to {OUT_PATH} (clipped to {CLIP_RADIUS_M}m radius)")
    print("highway tag breakdown:")
    for k, v in sorted(highway_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")

    if len(features) == 0:
        print("WARNING: 0 road features - query or parsing is likely broken.")

    # Verify every vertex in the output is within CLIP_RADIUS_M of the center.
    # A tiny epsilon tolerance absorbs floating-point/interpolation noise:
    # clip_linestring() interpolates the boundary crossing point linearly in
    # lon/lat space, while distance here is the (nonlinear) haversine great-
    # circle distance, so the "never overshoots" guarantee only holds to
    # floating-point precision (observed overshoots are on the order of
    # 1e-6 m, i.e. micrometers - far below GPS/rendering precision).
    EPSILON_M = 1e-3
    max_dist = 0.0
    vertex_count = 0
    over_limit = 0
    for feature in features:
        for lon, lat in feature["geometry"]["coordinates"]:
            d = dist_from_center(lon, lat)
            vertex_count += 1
            if d > max_dist:
                max_dist = d
            if d > CLIP_RADIUS_M + EPSILON_M:
                over_limit += 1
    print(
        f"Verification: {vertex_count} vertices, max distance from center = {max_dist:.6f}m, "
        f"{over_limit} vertices over {CLIP_RADIUS_M}m (+{EPSILON_M}m epsilon)"
    )
    if over_limit > 0:
        print(f"ERROR: {over_limit} vertices exceed the {CLIP_RADIUS_M}m clip radius!")
        sys.exit(1)
    else:
        print(f"OK: all vertices are within {CLIP_RADIUS_M}m (+{EPSILON_M}m epsilon) of the center.")


if __name__ == "__main__":
    main()
