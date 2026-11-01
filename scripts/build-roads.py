"""Build the road tiles in data/roads/ from Overture Maps (OpenStreetMap data).

Usage:
  pip install pyarrow shapely requests
  python3 scripts/build-roads.py download   # UK roads -> scripts/source/uk_roads.parquet
  python3 scripts/build-roads.py build      # -> data/roads/{x}_{y}.json + data/roads/index.json

Same approach and tile format as scripts/build-water.py: `download` reads
only the UK row groups of the Overture "transportation/segment" theme (the
global set is ~70 GB), and each 0.1° tile holds polyline-encoded lines by kind:
  major   motorways, trunk and primary roads (A roads)
  minor   secondary and tertiary roads (B roads and the like)
  lanes   unclassified roads, residential streets
  tracks  farm and forest tracks
  paths   footpaths, bridleways and other paths
Service roads (drives, car parks), rail and ferries are left out.
"""

import importlib.util
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

import pyarrow.compute as pc
import pyarrow.parquet as pq
import requests
import shapely

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "scripts/source/uk_roads.parquet"  # not committed (large)
OUT = ROOT / "data/roads"

# Share the HTTP range reader, polyline encoder and settings with the water build.
_spec = importlib.util.spec_from_file_location("build_water", ROOT / "scripts/build-water.py")
water = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(water)
BUCKET, RELEASE, UK, TILE, CA = water.BUCKET, water.RELEASE, water.UK, water.TILE, water.CA
SIMPLIFY_DEG = 0.00003  # ~3 m

KINDS = {
    "motorway": "major", "trunk": "major", "primary": "major",
    "secondary": "minor", "tertiary": "minor",
    "unclassified": "lanes", "residential": "lanes", "living_street": "lanes",
    "track": "tracks",
    "footway": "paths", "path": "paths", "bridleway": "paths", "steps": "paths", "cycleway": "paths", "pedestrian": "paths",
}


def download():
    prefix = f"{RELEASE}/theme=transportation/type=segment/"
    listing = requests.get(f"{BUCKET}/?list-type=2&prefix={prefix}", verify=CA, timeout=60).text
    keys = re.findall(r"<Key>([^<]*)</Key>", listing)
    writer = None
    RAW.parent.mkdir(parents=True, exist_ok=True)
    for key in keys:
        f = water.HttpFile(f"{BUCKET}/{key}")
        pf = pq.ParquetFile(f)
        md = pf.metadata
        idx = {md.row_group(0).column(i).path_in_schema: i for i in range(md.num_columns)}
        for g in range(md.num_row_groups):
            st = lambda p: md.row_group(g).column(idx[p]).statistics  # noqa: E731
            if not water.overlaps_uk(st("bbox.xmin").min, st("bbox.xmax").max, st("bbox.ymin").min, st("bbox.ymax").max):
                continue
            t = pf.read_row_group(g, columns=["subtype", "class", "geometry", "bbox"])
            bb = t.column("bbox")
            fld = lambda name: pc.struct_field(bb, name)  # noqa: E731
            keep = pc.and_(
                pc.and_(pc.greater_equal(fld("xmax"), UK[0]), pc.less_equal(fld("xmin"), UK[2])),
                pc.and_(pc.greater_equal(fld("ymax"), UK[1]), pc.less_equal(fld("ymin"), UK[3])),
            )
            keep = pc.and_(keep, pc.equal(t.column("subtype"), "road"))
            keep = pc.and_(keep, pc.is_in(t.column("class"), value_set=__import__("pyarrow").array(list(KINDS))))
            t = t.filter(keep).drop(["bbox", "subtype"])
            if t.num_rows:
                writer = writer or pq.ParquetWriter(RAW, t.schema, compression="zstd")
                writer.write_table(t)
        if f.fetched > 2_000_000:
            print(f"{key.rsplit('/', 1)[-1][:10]}: {f.fetched // 1_000_000} MB", flush=True)
    writer.close()


def build():
    t = pq.read_table(RAW)
    classes = t.column("class").to_pylist()
    geoms = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
    print(f"{len(geoms)} road segments read", flush=True)
    by_kind = defaultdict(list)
    for cls, g in zip(classes, geoms):
        if g is not None and not g.is_empty:
            by_kind[KINDS[cls]].append(g)
    print({k: len(v) for k, v in by_kind.items()}, flush=True)

    tiles = defaultdict(lambda: defaultdict(list))
    x0, y0 = math.floor(UK[0] / TILE), math.floor(UK[1] / TILE)
    x1, y1 = math.floor(UK[2] / TILE), math.floor(UK[3] / TILE)
    for kind, gs in by_kind.items():
        gs = shapely.simplify(gs, SIMPLIFY_DEG, preserve_topology=False)
        tree = shapely.STRtree(gs)
        for tx in range(x0, x1 + 1):
            for ty in range(y0, y1 + 1):
                box = shapely.box(tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE)
                hits = tree.query(box, predicate="intersects")
                if not len(hits):
                    continue
                # Join touching segments into longer lines: smaller tiles, smoother cuts.
                merged = shapely.line_merge(shapely.intersection(shapely.union_all(gs[hits]), box))
                for part in shapely.get_parts(merged):
                    if part.geom_type != "LineString":
                        continue
                    s = water.encode_line(shapely.get_coordinates(part).tolist())
                    if s:
                        tiles[(tx, ty)][kind].append(s)
        print(f"{kind}: done", flush=True)

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    total = 0
    for (tx, ty), kinds in tiles.items():
        body = json.dumps({k: ",".join(v) for k, v in kinds.items()}, separators=(",", ":"))
        (OUT / f"{tx}_{ty}.json").write_text(body)
        total += len(body)
    index = {"tile": TILE, "source": f"Overture Maps {RELEASE} (OpenStreetMap, ODbL)", "tiles": sorted(f"{x}_{y}" for x, y in tiles)}
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"{len(tiles)} tiles, {total / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    {"download": download, "build": build}[sys.argv[1] if len(sys.argv) > 1 else "build"]()
