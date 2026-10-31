"""Build the water tiles in data/water/ from Overture Maps (OpenStreetMap data).

Usage:
  pip install pyarrow shapely requests
  python3 scripts/build-water.py download   # ~470 MB of UK rows -> scripts/source/uk_water.parquet
  python3 scripts/build-water.py build      # -> data/water/{x}_{y}.json + data/water/index.json

`download` reads only the UK row groups of the Overture "base/water" theme
using HTTP range requests (the full global dataset is ~29 GB).

Each tile covers TILE x TILE degrees and holds four kinds of line, encoded with
Google's polyline algorithm (precision 5) and joined with ",":
  lakes   shorelines of lakes, tarns, ponds and reservoirs
  rivers  river and canal centre lines, plus the banks of wide rivers
  streams streams and becks
  coast   coastline (the edge of the sea)
"""

import io
import json
import math
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import pyarrow.compute as pc
import pyarrow.parquet as pq
import requests
import shapely

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "scripts/source/uk_water.parquet"  # not committed (large)
OUT = ROOT / "data/water"

BUCKET = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com"
RELEASE = "release/2026-10-21.0"  # newest Overture release when this was built
UK = (-8.7, 49.8, 1.9, 61.0)  # west, south, east, north
TILE = 0.1  # degrees
SIMPLIFY_DEG = 0.00003  # ~3 m; far finer than a laser can show at map scale
MIN_LAKE_M2 = 1500  # smaller ponds would be a dot on the board
CA = os.environ.get("REQUESTS_CA_BUNDLE") or True


class HttpFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests, for pyarrow."""

    def __init__(self, url):
        self.url, self.pos, self.fetched = url, 0, 0
        self.s = requests.Session()
        self.s.verify = CA
        self.size = int(self.s.head(url, timeout=60).headers["Content-Length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.size, self.pos + n) - 1
        for attempt in range(5):
            try:
                r = self.s.get(self.url, headers={"Range": f"bytes={self.pos}-{end}"}, timeout=300)
                r.raise_for_status()
                break
            except requests.RequestException:
                if attempt == 4:
                    raise
        self.pos += len(r.content)
        self.fetched += len(r.content)
        return r.content

    def readinto(self, b):
        d = self.read(len(b))
        b[: len(d)] = d
        return len(d)


def overlaps_uk(xmin, xmax, ymin, ymax):
    return xmax >= UK[0] and xmin <= UK[2] and ymax >= UK[1] and ymin <= UK[3]


def download():
    prefix = f"{RELEASE}/theme=base/type=water/"
    listing = requests.get(f"{BUCKET}/?list-type=2&prefix={prefix}", verify=CA, timeout=60).text
    keys = re.findall(r"<Key>([^<]*)</Key>", listing)
    cols = ["subtype", "class", "geometry", "bbox"]
    writer = None
    RAW.parent.mkdir(parents=True, exist_ok=True)
    for key in keys:
        f = HttpFile(f"{BUCKET}/{key}")
        pf = pq.ParquetFile(f)
        md = pf.metadata
        idx = {md.row_group(0).column(i).path_in_schema: i for i in range(md.num_columns)}
        for g in range(md.num_row_groups):
            st = lambda p: md.row_group(g).column(idx[p]).statistics  # noqa: E731
            if not overlaps_uk(st("bbox.xmin").min, st("bbox.xmax").max, st("bbox.ymin").min, st("bbox.ymax").max):
                continue
            t = pf.read_row_group(g, columns=cols)
            bb = t.column("bbox")
            f_ = lambda name: pc.struct_field(bb, name)  # noqa: E731
            keep = pc.and_(
                pc.and_(pc.greater_equal(f_("xmax"), UK[0]), pc.less_equal(f_("xmin"), UK[2])),
                pc.and_(pc.greater_equal(f_("ymax"), UK[1]), pc.less_equal(f_("ymin"), UK[3])),
            )
            t = t.filter(keep).drop(["bbox"])
            writer = writer or pq.ParquetWriter(RAW, t.schema, compression="zstd")
            writer.write_table(t)
        print(f"{key.rsplit('/', 1)[-1][:10]}: {f.fetched // 1_000_000} MB", flush=True)
    writer.close()


# --- Building ---
def encode_line(coords):
    out, plat, plng = [], 0, 0

    def enc(v):
        v = ~(v << 1) if v < 0 else v << 1
        s = ""
        while v >= 0x20:
            s += chr((0x20 | (v & 0x1F)) + 63)
            v >>= 5
        return s + chr(v + 63)

    for lng, lat in coords:
        la, ln = round(lat * 1e5), round(lng * 1e5)
        if out and la == plat and ln == plng:
            continue
        out.append(enc(la - plat) + enc(ln - plng))
        plat, plng = la, ln
    return "".join(out) if len(out) > 1 else ""


def area_m2(geom):
    lat = shapely.get_y(shapely.centroid(geom))
    return shapely.area(geom) * 111320 * math.cos(math.radians(lat)) * 110574


def classify(subtype, cls, gtype):
    poly = gtype in ("Polygon", "MultiPolygon")
    line = gtype in ("LineString", "MultiLineString")
    if line and cls == "stream":
        return "streams"
    if line and cls in ("river", "canal"):
        return "rivers"
    if poly and subtype in ("river", "canal") and cls in ("river", "canal"):
        return "rivers"  # banks of wide rivers
    if poly and (subtype in ("lake", "pond", "reservoir") and cls not in ("basin", "water_storage")):
        return "lakes"
    if poly and subtype == "water" and cls == "water":
        return "lakes"  # untyped natural=water, mostly lakes and tarns
    if poly and subtype == "ocean":
        return "ocean"
    return None


def as_lines(geom):
    """Polygons -> their rings as lines; lines unchanged."""
    if shapely.get_type_id(geom) in (3, 6):  # Polygon, MultiPolygon
        return shapely.boundary(geom)
    return geom


def build():
    t = pq.read_table(RAW)
    subtypes, classes = t.column("subtype").to_pylist(), t.column("class").to_pylist()
    geoms = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
    print(f"{len(geoms)} features read", flush=True)

    kinds = defaultdict(list)
    ocean = []
    for sub, cls, g in zip(subtypes, classes, geoms):
        if g is None or g.is_empty:
            continue
        kind = classify(sub, cls, g.geom_type)
        if kind is None:
            continue
        if kind == "ocean":
            ocean.append(g)
        elif kind == "lakes" and area_m2(g) < MIN_LAKE_M2:
            continue
        else:
            kinds[kind].append(as_lines(g))
    print({k: len(v) for k, v in kinds.items()}, "ocean polygons", len(ocean), flush=True)

    # Coastline: the edge of the merged sea, minus the cut edges of the data area.
    if ocean:
        sea = shapely.union_all(shapely.make_valid(shapely.buffer(ocean, 0)))
        inner = shapely.box(UK[0] + 0.01, UK[1] + 0.01, UK[2] - 0.01, UK[3] - 0.01)
        kinds["coast"] = [shapely.intersection(shapely.boundary(sea), inner)]

    tiles = defaultdict(lambda: defaultdict(list))
    for kind, geoms_ in kinds.items():
        geoms_ = shapely.simplify(geoms_, SIMPLIFY_DEG, preserve_topology=False)
        tree = shapely.STRtree(geoms_)
        x0, y0 = math.floor(UK[0] / TILE), math.floor(UK[1] / TILE)
        x1, y1 = math.floor(UK[2] / TILE), math.floor(UK[3] / TILE)
        for tx in range(x0, x1 + 1):
            for ty in range(y0, y1 + 1):
                box = shapely.box(tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE)
                hits = tree.query(box, predicate="intersects")
                if not len(hits):
                    continue
                clipped = shapely.intersection(geoms_[hits], box)
                for g in clipped:
                    for part in shapely.get_parts(shapely.line_merge(g) if g.geom_type == "MultiLineString" else g):
                        if part.geom_type != "LineString":
                            continue
                        s = encode_line(shapely.get_coordinates(part).tolist())
                        if s:
                            tiles[(tx, ty)][kind].append(s)
        print(f"{kind}: done", flush=True)

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    total = 0
    for (tx, ty), by_kind in tiles.items():
        body = json.dumps({k: ",".join(v) for k, v in by_kind.items()}, separators=(",", ":"))
        (OUT / f"{tx}_{ty}.json").write_text(body)
        total += len(body)
    index = {"tile": TILE, "source": f"Overture Maps {RELEASE} (OpenStreetMap, ODbL)", "tiles": sorted(f"{x}_{y}" for x, y in tiles)}
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"{len(tiles)} tiles, {total / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    {"download": download, "build": build}[sys.argv[1] if len(sys.argv) > 1 else "build"]()
