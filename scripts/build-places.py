"""Build data/places.json (UK city, town and village names) from Overture Maps.

Usage: pip install pyarrow requests; python3 scripts/build-places.py

Reads the Overture "divisions/division" file (OpenStreetMap-based) with HTTP
range requests, keeping UK localities classed city, town or village. Output:
{ "places": [[name, kind, lng, lat, population], ...] }, kind c/t/v.
"""

import importlib.util
import json
import re
from pathlib import Path

import pyarrow.compute as pc
import pyarrow.parquet as pq
import requests
import shapely

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/places.json"
_spec = importlib.util.spec_from_file_location("build_water", ROOT / "scripts/build-water.py")
water = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(water)
KINDS = {"city": "c", "town": "t", "village": "v"}

prefix = f"{water.RELEASE}/theme=divisions/type=division/"
keys = re.findall(r"<Key>([^<]*)</Key>", requests.get(f"{water.BUCKET}/?list-type=2&prefix={prefix}", verify=water.CA, timeout=60).text)
places = []
for key in keys:
    pf = pq.ParquetFile(water.HttpFile(f"{water.BUCKET}/{key}"))
    md = pf.metadata
    idx = {md.row_group(0).column(i).path_in_schema: i for i in range(md.num_columns)}
    for g in range(md.num_row_groups):
        st = lambda p: md.row_group(g).column(idx[p]).statistics  # noqa: E731
        if not water.overlaps_uk(st("bbox.xmin").min, st("bbox.xmax").max, st("bbox.ymin").min, st("bbox.ymax").max):
            continue
        t = pf.read_row_group(g, columns=["subtype", "class", "country", "names", "population", "geometry"])
        t = t.filter(pc.and_(pc.equal(t.column("country"), "GB"), pc.equal(t.column("subtype"), "locality")))
        t = t.filter(pc.is_in(t.column("class"), value_set=__import__("pyarrow").array(list(KINDS))))
        geoms = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
        for cls, names, pop, geom in zip(t.column("class").to_pylist(), t.column("names").to_pylist(), t.column("population").to_pylist(), geoms):
            name = (names or {}).get("primary")
            if not name or geom is None:
                continue
            p = geom if geom.geom_type == "Point" else geom.representative_point()
            places.append([name, KINDS[cls], round(p.x, 5), round(p.y, 5), pop or 0])
places.sort(key=lambda p: ("ctv".index(p[1]), -p[4]))
OUT.write_text(json.dumps({"source": f"Overture Maps {water.RELEASE} (OpenStreetMap, ODbL)", "places": places}, separators=(",", ":"), ensure_ascii=False))
print(len(places), "places:", {k: sum(1 for p in places if p[1] == v) for k, v in KINDS.items()}, f"{OUT.stat().st_size / 1e6:.1f} MB")
