"""
Fetch named points of interest (buildings, shops, amenities, offices,
railway features, tourism sites) within ~1000m of Otemachi station from the
Overpass API and write them out as a GeoJSON Point FeatureCollection at
public/data/places.geojson. This powers the "search by name" start/end
picker, as an alternative to tapping the map.

The raw Overpass JSON response is cached at
scripts/.cache/overpass_places_raw.json so this script does not need to hit
the network again on re-runs (pass --refetch to force a new request).

Usage:
    python scripts/fetch_places.py [--refetch]
"""
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
CACHE_PATH = ROOT_DIR / "scripts" / ".cache" / "overpass_places_raw.json"
OUT_PATH = ROOT_DIR / "public" / "data" / "places.geojson"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Same center/radius as fetch_roads.py / fetch_trees.py / extract_buildings.py
CENTER_LAT = 35.6862
CENTER_LON = 139.7671
RADIUS_M = 1000.0

# Priority order used to pick a single category when an element has multiple
# of these tags set.
CATEGORY_KEYS = ["building", "shop", "amenity", "office", "railway", "tourism"]

QUERY = f"""
[out:json][timeout:90];
(
  nwr["name"]["building"](around:{RADIUS_M:.0f},{CENTER_LAT},{CENTER_LON});
  nwr["name"]["shop"](around:{RADIUS_M:.0f},{CENTER_LAT},{CENTER_LON});
  nwr["name"]["amenity"](around:{RADIUS_M:.0f},{CENTER_LAT},{CENTER_LON});
  nwr["name"]["office"](around:{RADIUS_M:.0f},{CENTER_LAT},{CENTER_LON});
  nwr["name"]["railway"](around:{RADIUS_M:.0f},{CENTER_LAT},{CENTER_LON});
  nwr["name"]["tourism"](around:{RADIUS_M:.0f},{CENTER_LAT},{CENTER_LON});
);
out tags center;
""".strip()


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
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = resp.read()
    return json.loads(body)


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


def element_lat_lon(el):
    """Nodes carry lat/lon directly; ways/relations only carry a center (from `out ... center`)."""
    if "lat" in el and "lon" in el:
        return el["lat"], el["lon"]
    center = el.get("center")
    if center and "lat" in center and "lon" in center:
        return center["lat"], center["lon"]
    return None


def element_category(tags):
    for key in CATEGORY_KEYS:
        if key in tags:
            return key
    return None


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

    with_name = 0
    category_counts = {}
    features = []
    skipped_out_of_radius = 0

    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        with_name += 1

        latlon = element_lat_lon(el)
        if latlon is None:
            continue

        category = element_category(tags)
        if category is None:
            continue

        lat, lon = latlon

        # Overpass's `around:` filter includes a whole way/relation if ANY of
        # its nodes falls within the radius, but for those elements we only
        # have the `center` (centroid of the whole geometry), which can lie
        # well outside RADIUS_M even when the query matched (e.g. long
        # railway ways). Enforce the documented 1000m radius explicitly here,
        # the same way fetch_roads.py's clip_linestring()/verification does
        # for line geometries.
        if dist_from_center(lon, lat) > RADIUS_M:
            skipped_out_of_radius += 1
            continue

        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat],
            },
            "properties": {
                "id": f"place-{len(features)}",
                "name": name,
                "category": category,
            },
        }
        features.append(feature)
        category_counts[category] = category_counts.get(category, 0) + 1

    fc = {
        "type": "FeatureCollection",
        "features": features,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)

    print(f"Elements with a name tag: {with_name}")
    print(f"Skipped (center point beyond {RADIUS_M:.0f}m radius): {skipped_out_of_radius}")
    print(f"Wrote {len(features)} place features to {OUT_PATH}")
    print("category breakdown:")
    for k, v in sorted(category_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")

    if len(features) == 0:
        print("WARNING: 0 place features - query or parsing is likely broken.")

    # Verify every output feature is within RADIUS_M of the center (mirrors
    # the verification fetch_roads.py performs after clipping).
    max_dist = 0.0
    over_limit = 0
    for feature in features:
        lon, lat = feature["geometry"]["coordinates"]
        d = dist_from_center(lon, lat)
        if d > max_dist:
            max_dist = d
        if d > RADIUS_M:
            over_limit += 1
    print(
        f"Verification: {len(features)} features, max distance from center = {max_dist:.6f}m, "
        f"{over_limit} features over {RADIUS_M:.0f}m"
    )
    if over_limit > 0:
        print(f"ERROR: {over_limit} features exceed the {RADIUS_M:.0f}m radius!")
        sys.exit(1)
    else:
        print(f"OK: all features are within {RADIUS_M:.0f}m of the center.")


if __name__ == "__main__":
    main()
