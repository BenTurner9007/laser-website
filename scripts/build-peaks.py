"""Add named peaks across Great Britain and all of Ireland to data/hills.geojson.

    python3 scripts/build-hills.mjs        # first: the hill-list hills (DoBIH)
    python3 scripts/build-peaks.py         # then: every other named peak

Reads the Overture Maps "base/land" theme (OpenStreetMap peaks: natural=peak,
hill and volcano with a name and a height) for the UK and Ireland, using HTTP
range requests for just the row groups in that area. Peaks within 300 m of a
hill already in data/hills.geojson (from the Database of British and Irish
Hills, whose names and heights are kept) are skipped. The rest are added with
the list "osm" ("Other named hills"). Running it again replaces them.

Needs: pyarrow, requests (and the helpers in build-water.py).
"""
import importlib.util
import json
import math
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import requests

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("water", ROOT / "scripts/build-water.py")
water = importlib.util.module_from_spec(spec)
spec.loader.exec_module(water)

OUT = ROOT / "data/hills.geojson"
CLASSES = ["peak", "hill", "volcano"]
NEAR_M = 300  # an OSM peak this close to a listed hill is the same hill


def metres(a, b):
    (x1, y1), (x2, y2) = a, b
    k = math.cos(math.radians((y1 + y2) / 2))
    return math.hypot((x2 - x1) * 111320 * k, (y2 - y1) * 110574)


def main():
    data = json.loads(OUT.read_text())
    listed = [f for f in data["features"] if ",osm," not in f["properties"]["lists"]]
    # Grid of listed hills for the "already there" check.
    grid = {}
    for f in listed:
        x, y = f["geometry"]["coordinates"]
        grid.setdefault((round(x * 50), round(y * 50)), []).append((x, y))

    def near_listed(x, y):
        gx, gy = round(x * 50), round(y * 50)
        return any(metres((x, y), p) < NEAR_M for dx in (-1, 0, 1) for dy in (-1, 0, 1) for p in grid.get((gx + dx, gy + dy), []))

    prefix = f"{water.RELEASE}/theme=base/type=land/"
    keys = []
    token = None
    while True:  # the land theme has more files than one listing page
        url = f"{water.BUCKET}/?list-type=2&prefix={prefix}" + (f"&continuation-token={requests.utils.quote(token)}" if token else "")
        text = requests.get(url, verify=water.CA, timeout=60).text
        keys += water.re.findall(r"<Key>([^<]*)</Key>", text)
        m = water.re.search(r"<NextContinuationToken>([^<]*)</NextContinuationToken>", text)
        if not m:
            break
        token = m.group(1)

    peaks = []
    for key in keys:
        f = water.HttpFile(f"{water.BUCKET}/{key}")
        pf = pq.ParquetFile(f)
        md = pf.metadata
        idx = {md.row_group(0).column(i).path_in_schema: i for i in range(md.num_columns)}
        for g in range(md.num_row_groups):
            st = lambda p: md.row_group(g).column(idx[p]).statistics  # noqa: E731
            if not water.overlaps_uk(st("bbox.xmin").min, st("bbox.xmax").max, st("bbox.ymin").min, st("bbox.ymax").max):
                continue
            t = pf.read_row_group(g, columns=["class", "bbox"])
            keep = pc.is_in(t.column("class"), value_set=pa.array(CLASSES))
            if not pc.any(keep).as_py():
                continue
            t = pf.read_row_group(g, columns=["class", "names", "elevation", "bbox"]).filter(keep)
            for names, ele, bb in zip(t.column("names").to_pylist(), t.column("elevation").to_pylist(), t.column("bbox").to_pylist()):
                name = (names or {}).get("primary")
                x, y = bb["xmin"], bb["ymin"]
                if not name or ele is None or ele <= 0:
                    continue
                if not (water.UK[0] <= x <= water.UK[2] and water.UK[1] <= y <= water.UK[3]):
                    continue
                if near_listed(x, y):
                    continue
                peaks.append((name.strip(), round(ele), round(x, 5), round(y, 5)))
        print(f"{key.rsplit('/', 1)[-1][:10]}: {f.fetched // 1_000_000} MB, {len(peaks)} peaks so far", flush=True)

    # One per name and spot (OSM sometimes has the same peak twice).
    seen, added = set(), []
    for name, h, x, y in sorted(peaks, key=lambda p: -p[1]):
        k = (name.lower(), round(x * 200), round(y * 200))
        if k in seen:
            continue
        seen.add(k)
        added.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [x, y]}, "properties": {"name": name, "h": h, "lists": ",osm,"}})

    data["features"] = listed + added
    data.setdefault("sources", [])
    note = f"Other named hills: OpenStreetMap contributors (ODbL), via Overture Maps {water.RELEASE}"
    data["sources"] = [s for s in data["sources"] if "OpenStreetMap" not in s] + [note]
    OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(listed)} listed hills + {len(added)} other named peaks -> {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
