"""Trace the shop logo into outlines for engraving on the logo back plate.

    python3 scripts/build-logo.py [images/logo.jpg] [data/logo.json]

Everything brighter than the dark background (the grey lettering and the
orange arrow and rules) becomes engraved area. The image is enlarged and
smoothed before tracing so the edges come out as clean curves rather than
pixel steps. For the crispest result, trace a vector copy of the logo
instead, or replace data/logo.json with outlines exported from it.

Output: {"w": width, "h": height, "polys": [polygon, ...]} in source pixels,
each polygon a list of rings [[x, y], ...], outer ring first. The site scales
it to fit the plate.
Needs: pillow, numpy, rasterio, shapely.
"""
import json
import sys

import numpy as np
from PIL import Image, ImageFilter
from rasterio import features
from shapely.geometry import shape
from shapely.ops import unary_union

SRC = sys.argv[1] if len(sys.argv) > 1 else "images/logo.jpg"
OUT = sys.argv[2] if len(sys.argv) > 2 else "data/logo.json"
UP = 8  # enlarge before tracing
THRESHOLD = 92  # brightest channel above this counts as logo (background is ~52)
MIN_AREA = 2.0  # source px²; drops JPEG speckle

im = Image.open(SRC).convert("RGB")
w, h = im.size
big = im.resize((w * UP, h * UP), Image.BICUBIC).filter(ImageFilter.GaussianBlur(UP * 0.6))
mask = (np.asarray(big).max(axis=2) > THRESHOLD).astype(np.uint8)

shapes = [shape(g) for g, v in features.shapes(mask, mask=mask.astype(bool)) if v == 1]
geom = unary_union(shapes).simplify(UP * 0.12)
geoms = getattr(geom, "geoms", [geom])

polys = []
for g in geoms:
    if g.area / UP**2 < MIN_AREA:
        continue
    rings = [g.exterior] + [r for r in g.interiors if abs(shape({"type": "Polygon", "coordinates": [r.coords]}).area) / UP**2 >= MIN_AREA / 2]
    polys.append([[[round(x / UP, 2), round(y / UP, 2)] for x, y in r.coords] for r in rings])

json.dump({"w": w, "h": h, "polys": polys}, open(OUT, "w"), separators=(",", ":"))
print(f"{len(polys)} shapes, {sum(len(r) for p in polys for r in p)} points -> {OUT}")
