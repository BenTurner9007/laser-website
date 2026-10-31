"""Convert a clock-face DXF into data/clock-305.json for the website.

Usage: python3 scripts/build-clock.py [scripts/source/clock-305.dxf] [data/clock-305.json]
Needs ezdxf (pip install ezdxf).

Expected DXF layout:
  Layer_0  one closed polyline: the outer edge of the clock (cut)
  Layer_2  closed polylines: numbers and decorations (engraved), plus a small
           circle/ellipse at the centre: the hole for the clock movement (cut)

Output coordinates are millimetres, origin at the top-left of the clock's
bounding square, y pointing down (same as the SVG layouts).
"""
import json
import math
import sys
from pathlib import Path

import ezdxf
from ezdxf import path as ezpath

root = Path(__file__).resolve().parent.parent
src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "scripts/source/clock-305.dxf"
out = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "data/clock-305.json"

doc = ezdxf.readfile(src)
msp = doc.modelspace()

edge = [e for e in msp if e.dxf.layer == "Layer_0"]
assert len(edge) == 1, "expected one outline on Layer_0"
edge_pts = [(v.x, v.y) for v in ezpath.make_path(edge[0]).flattening(0.05)]
xs, ys = [p[0] for p in edge_pts], [p[1] for p in edge_pts]
cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
diameter = round(((max(xs) - min(xs)) + (max(ys) - min(ys))) / 2, 2)
r = diameter / 2


def to_mm(pts):
    # DXF y points up; flip so y points down, origin at the bounding square's corner.
    return [[round(x - cx + r, 3), round(cy - y + r, 3)] for x, y in pts]


engrave, hole = [], None
for e in msp:
    if e.dxf.layer != "Layer_2":
        continue
    if e.dxftype() in ("ELLIPSE", "CIRCLE"):
        c = e.dxf.center
        if math.hypot(c.x - cx, c.y - cy) < 1:
            size = (e.dxf.major_axis.magnitude * 2) if e.dxftype() == "ELLIPSE" else e.dxf.radius * 2
            hole = round(size, 2)
            continue
    pts = [(v.x, v.y) for v in ezpath.make_path(e).flattening(0.03)]
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    engrave.append(to_mm(pts))

data = {
    "name": "Clock 305 mm",
    "source": src.name,
    "diameter": diameter,
    "holeDiameter": hole,
    # Closed rings; holes in numbers (e.g. the 6 and 9) are separate rings,
    # so fill them with the even-odd rule.
    "engrave": engrave,
}
out.write_text(json.dumps(data, separators=(",", ":")))
print(f"diameter {diameter} mm, centre hole {hole} mm, {len(engrave)} engraved rings -> {out}")
