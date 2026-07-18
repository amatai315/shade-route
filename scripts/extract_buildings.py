"""
Extract buildings near Otemachi station (radius 1000m) from PLATEAU Chiyoda
building CityGML files packed inside raw-data/chiyoda-buildings.zip, and
write them out as a GeoJSON FeatureCollection at public/data/buildings.geojson.

Eight zip entries cover the target area (others are out of range):
    udx/bldg/53394610_bldg_6697_op.gml
    udx/bldg/53394611_bldg_6697_op.gml
    udx/bldg/53394620_bldg_6697_op.gml
    udx/bldg/53394621_bldg_6697_op.gml
    udx/bldg/53394622_bldg_6697_op.gml
    udx/bldg/53394630_bldg_6697_op.gml
    udx/bldg/53394631_bldg_6697_op.gml
    udx/bldg/53394632_bldg_6697_op.gml

The zip is ~1.9GB and the GML entries total roughly ~1GB uncompressed,
so this script streams each entry via zipfile.ZipFile.open() and parses it
incrementally with xml.etree.ElementTree.iterparse(), clearing elements as
it goes so memory stays low regardless of file size.

Usage:
    python scripts/extract_buildings.py
"""
import math
import json
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
ZIP_PATH = ROOT_DIR / "raw-data" / "chiyoda-buildings.zip"
OUT_PATH = ROOT_DIR / "public" / "data" / "buildings.geojson"

ENTRIES = [
    "udx/bldg/53394610_bldg_6697_op.gml",
    "udx/bldg/53394611_bldg_6697_op.gml",
    "udx/bldg/53394620_bldg_6697_op.gml",
    "udx/bldg/53394621_bldg_6697_op.gml",
    "udx/bldg/53394622_bldg_6697_op.gml",
    "udx/bldg/53394630_bldg_6697_op.gml",
    "udx/bldg/53394631_bldg_6697_op.gml",
    "udx/bldg/53394632_bldg_6697_op.gml",
]

# Otemachi station center
CENTER_LAT = 35.6862
CENTER_LON = 139.7671
RADIUS_M = 1000.0

# meters per degree (local planar approximation around Otemachi)
M_PER_DEG_LAT = 111000.0
M_PER_DEG_LON = 111000.0 * math.cos(math.radians(CENTER_LAT))

GML_NS = "http://www.opengis.net/gml"
BLDG_NS = "http://www.opengis.net/citygml/building/2.0"

BUILDING_TAG = f"{{{BLDG_NS}}}Building"
MEASURED_HEIGHT_TAG = f"{{{BLDG_NS}}}measuredHeight"
LOD0_ROOFEDGE_TAG = f"{{{BLDG_NS}}}lod0RoofEdge"
POSLIST_TAG = f"{{{GML_NS}}}posList"
GML_ID_ATTR = f"{{{GML_NS}}}id"


def dist_m(lat, lon):
    dx = (lon - CENTER_LON) * M_PER_DEG_LON
    dy = (lat - CENTER_LAT) * M_PER_DEG_LAT
    return math.sqrt(dx * dx + dy * dy)


def parse_poslist_to_ring(text):
    """gml:posList text = 'lat lon h lat lon h ...' -> [[lon, lat], ...]"""
    nums = [float(x) for x in text.split()]
    ring = []
    for i in range(0, len(nums) - 2, 3):
        lat, lon, _h = nums[i], nums[i + 1], nums[i + 2]
        ring.append([lon, lat])
    return ring


def centroid(ring):
    # simple average of vertices (ring is closed: first == last, fine for approx centroid)
    n = len(ring)
    sx = sum(p[0] for p in ring) / n
    sy = sum(p[1] for p in ring) / n
    return sy, sx  # returns (lat, lon)


def process_building(elem):
    """Returns (status, feature_or_None).

    status is one of: 'ok', 'no_height', 'no_geom', 'out_of_range'
    """
    gml_id = elem.get(GML_ID_ATTR)

    height_elem = elem.find(f".//{MEASURED_HEIGHT_TAG}")
    if height_elem is None or not height_elem.text:
        return "no_height", None
    try:
        height = float(height_elem.text)
    except ValueError:
        return "no_height", None
    if height < 0:
        # PLATEAU uses -9999 (and similar negative sentinels) to mean
        # "no data" for measuredHeight. Such buildings are unusable for
        # shadow calculations, so skip them here.
        return "no_height", None

    roofedge_elem = elem.find(f".//{LOD0_ROOFEDGE_TAG}")
    if roofedge_elem is None:
        return "no_geom", None
    poslist_elem = roofedge_elem.find(f".//{POSLIST_TAG}")
    if poslist_elem is None or not poslist_elem.text:
        return "no_geom", None

    ring = parse_poslist_to_ring(poslist_elem.text)
    if len(ring) < 4:
        return "no_geom", None

    clat, clon = centroid(ring)
    if dist_m(clat, clon) > RADIUS_M:
        return "out_of_range", None

    feature = {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [ring],
        },
        "properties": {
            "height": height,
            "id": gml_id,
        },
    }
    return "ok", feature


def iter_buildings_from_stream(stream, label):
    context = ET.iterparse(stream, events=("start", "end"))
    _, root = next(context)  # 'start' event on root element

    count = 0
    for event, elem in context:
        if event == "end" and elem.tag == BUILDING_TAG:
            count += 1
            yield elem
            elem.clear()
            root.clear()
    print(f"  [{label}] total Building elements parsed: {count}")


def main():
    if not ZIP_PATH.exists():
        raise SystemExit(f"zip not found: {ZIP_PATH}")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    features = []
    stats = {"ok": 0, "no_height": 0, "no_geom": 0, "out_of_range": 0}
    with zipfile.ZipFile(ZIP_PATH) as zf:
        for entry in ENTRIES:
            print(f"Processing {entry} ...")
            with zf.open(entry) as raw_stream:
                for building_elem in iter_buildings_from_stream(raw_stream, entry):
                    status, feat = process_building(building_elem)
                    stats[status] += 1
                    if feat is not None:
                        features.append(feat)

    print(
        f"Building status breakdown: ok={stats['ok']} "
        f"no_height_data={stats['no_height']} no_geom={stats['no_geom']} "
        f"out_of_range={stats['out_of_range']}"
    )

    fc = {
        "type": "FeatureCollection",
        "features": features,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)

    print(f"Extracted {len(features)} buildings within {RADIUS_M}m of Otemachi station.")
    print(f"Wrote {OUT_PATH}")

    if features:
        heights = [feat["properties"]["height"] for feat in features]
        print(f"height min={min(heights):.2f} max={max(heights):.2f} mean={sum(heights)/len(heights):.2f}")

    if len(features) == 0:
        print("WARNING: 0 features extracted - check radius/logic for bugs.")
    elif len(features) > 1000:
        print("WARNING: >1000 features extracted - check radius/logic for bugs.")


if __name__ == "__main__":
    main()
