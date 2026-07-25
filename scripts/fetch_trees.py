"""
Fetch street tree data (都道の街路樹, 23 wards) from the Tokyo Metropolitan
Government open data portal and write out the trees within ~1000m of
Otemachi station as a GeoJSON FeatureCollection at public/data/trees.geojson.

The raw CSV download is cached at scripts/.cache/tokyo_gairoju.csv so this
script does not need to hit the network again on re-runs (pass --refetch to
force a new download). The file is Shift-JIS encoded, not UTF-8.

Only 高木 (tall trees) rows are kept: 中木 (mid-height trees) has no 枝張
(crown spread) data for any row in this dataset, so a shadow footprint can't
be derived for them from real data.

Usage:
    python scripts/fetch_trees.py [--refetch]
"""
import csv
import io
import math
import json
import sys
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
CACHE_PATH = ROOT_DIR / "scripts" / ".cache" / "tokyo_gairoju.csv"
OUT_PATH = ROOT_DIR / "public" / "data" / "trees.geojson"

CSV_URL = "https://www.opendata.metro.tokyo.lg.jp/kensetsu/tokyo_gairoju.csv"
CSV_ENCODING = "shift_jis"

# Otemachi station center - same center/radius as extract_buildings.py and fetch_roads.py
CENTER_LAT = 35.6862
CENTER_LON = 139.7671
RADIUS_M = 1000.0

# meters per degree (local planar approximation around Otemachi)
M_PER_DEG_LAT = 111000.0
M_PER_DEG_LON = 111000.0 * math.cos(math.radians(CENTER_LAT))

TARGET_WARD = "千代田区"
TARGET_CATEGORY = "高木"


def dist_m(lat, lon):
    dx = (lon - CENTER_LON) * M_PER_DEG_LON
    dy = (lat - CENTER_LAT) * M_PER_DEG_LAT
    return math.sqrt(dx * dx + dy * dy)


def fetch_csv_bytes():
    req = urllib.request.Request(
        CSV_URL,
        headers={"User-Agent": "shade-route-poc/1.0"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def main():
    refetch = "--refetch" in sys.argv
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    if CACHE_PATH.exists() and not refetch:
        print(f"Using cached CSV: {CACHE_PATH}")
        raw_bytes = CACHE_PATH.read_bytes()
    else:
        print(f"Downloading {CSV_URL} ...")
        raw_bytes = fetch_csv_bytes()
        CACHE_PATH.write_bytes(raw_bytes)
        print(f"Cached raw CSV to {CACHE_PATH}")

    text = raw_bytes.decode(CSV_ENCODING)
    reader = csv.DictReader(io.StringIO(text))

    total = 0
    after_ward = 0
    after_category = 0
    features = []

    for row in reader:
        total += 1
        if row["行政区"] != TARGET_WARD:
            continue
        after_ward += 1
        if row["区分"] != TARGET_CATEGORY:
            continue
        after_category += 1

        lat = float(row["緯度"])
        lon = float(row["経度"])
        if dist_m(lat, lon) > RADIUS_M:
            continue

        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat],
            },
            "properties": {
                "id": f"tree-{len(features)}",
                "species": row["樹種"],
                "height": float(row["樹高(m)"]),
                "crownDiameter": float(row["枝張(m)"]),
            },
        }
        features.append(feature)

    fc = {
        "type": "FeatureCollection",
        "features": features,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)

    print(f"Total rows: {total}")
    print(f"After 行政区=={TARGET_WARD}: {after_ward}")
    print(f"After 区分=={TARGET_CATEGORY}: {after_category}")
    print(f"After radius<={RADIUS_M}m filter: {len(features)}")
    print(f"Wrote {len(features)} tree features to {OUT_PATH}")

    if features:
        heights = [feat["properties"]["height"] for feat in features]
        crowns = [feat["properties"]["crownDiameter"] for feat in features]
        print(f"height min={min(heights):.2f} max={max(heights):.2f} mean={sum(heights)/len(heights):.2f}")
        print(f"crownDiameter min={min(crowns):.2f} max={max(crowns):.2f} mean={sum(crowns)/len(crowns):.2f}")

    if len(features) == 0:
        print("WARNING: 0 features extracted - check filters/radius for bugs.")


if __name__ == "__main__":
    main()
