"""Build data/coast.json: a simplified coastline of Great Britain and Ireland
for maps and layouts too large for the detailed water tiles.

    python3 scripts/build-coast.py     # needs scripts/source/uk_water.parquet (build-water.py download)

Output: {"box": [w, s, e, n], "tol": degrees, "land": "rings"} with the rings
encoded like the water tiles (Google polyline, precision 5, joined with ",").
"land" is the land inside box (fill even-odd); outside box the sea is not
known. The coastline is the rings' edges, less any lying along box. Islands smaller than MIN_KM2 are dropped.
Needs: pyarrow, shapely (and the helpers in build-water.py).
"""
import importlib.util
import json
from pathlib import Path

import shapely

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("water", ROOT / "scripts/build-water.py")
water = importlib.util.module_from_spec(spec)
spec.loader.exec_module(water)

OUT = ROOT / "data/coast.json"
TOL = 0.0008  # degrees, about 60-90 m: far finer than 1 mm on a board this big
MIN_KM2 = 0.02


def main():
    subtypes, classes, geoms = water.read_raw()
    ocean = [g for s, c, g in zip(subtypes, classes, geoms) if g is not None and not g.is_empty and water.classify(s, c, g.geom_type) == "ocean"]
    sea = shapely.union_all(shapely.make_valid(shapely.buffer(ocean, 0)))
    box = shapely.box(*water.UK)
    land = shapely.make_valid(shapely.simplify(shapely.difference(box, sea), TOL, preserve_topology=True))
    rings = []
    for part in shapely.get_parts(land):
        if part.geom_type != "Polygon" or water.area_m2(part) < MIN_KM2 * 1e6:
            continue
        for ring in [part.exterior, *[r for r in part.interiors if water.area_m2(shapely.Polygon(r)) >= MIN_KM2 * 1e6]]:
            e = water.encode_line(shapely.get_coordinates(ring).tolist())
            if e:
                rings.append(e)
    OUT.write_text(json.dumps({"box": list(water.UK), "tol": TOL, "land": ",".join(rings)}, separators=(",", ":")))
    print(f"{len(rings)} rings -> {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
