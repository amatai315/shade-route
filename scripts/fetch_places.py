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
    print(f"Wrote {len(features)} place features to {OUT_PATH}")
    print("category breakdown:")
    for k, v in sorted(category_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")

    if len(features) == 0:
        print("WARNING: 0 place features - query or parsing is likely broken.")


if __name__ == "__main__":
    main()
