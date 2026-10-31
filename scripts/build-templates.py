"""Convert board-shape DXFs into templates in data/templates/.

Usage: python3 scripts/build-templates.py      (needs: pip install ezdxf)

Each entry in TEMPLATES names a DXF in scripts/source/ and says what its
inner shapes are for:
  outline     the largest closed shape: the board's edge (cut)
  inner       other closed shapes on the outline's layer, inside it:
                "holes"     cut through every layer (tassel hole, clock spindle)
                "map-area"  the contour map only fills this shape; the rest of
                            the base board is a plain border
  engrave     layers whose shapes are engraved (e.g. clock numbers); a small
              circle at the board's centre on these layers is a hole instead

Output (mm, origin at the outline's top-left corner, y down):
  { name, w, h, outline: ring, holes: [ring], mapArea: ring | null, engrave: [ring] }
"""

import json
import math
from pathlib import Path

import ezdxf
from ezdxf import path as ezpath

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "scripts/source"
OUT = ROOT / "data/templates"

TEMPLATES = [
    {"id": "clock-305", "dxf": "clock-305.dxf", "name": "Clock 305 mm", "inner": "holes", "engrave": ["Layer_2"]},
    {"id": "bookmark", "dxf": "bookmark.dxf", "name": "Bookmark", "inner": "holes"},
    {"id": "coaster-round", "dxf": "coaster-round.dxf", "name": "Round coaster", "inner": "holes"},
    {"id": "coaster-square", "dxf": "coaster-square.dxf", "name": "Square coaster", "inner": "map-area"},
    {"id": "coaster-rounded-square", "dxf": "coaster-rounded-square.dxf", "name": "Rounded square coaster", "inner": "map-area"},
]

FLATTEN_MM = 0.03


def ring_of(entity):
    pts = [(v.x, v.y) for v in ezpath.make_path(entity).flattening(FLATTEN_MM)]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    return pts


def area(r):
    return abs(sum(r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1] for i in range(len(r)))) / 2


def bbox(r):
    xs, ys = [p[0] for p in r], [p[1] for p in r]
    return min(xs), min(ys), max(xs), max(ys)


def inside(r, p):
    x, y = p
    c = False
    for i in range(len(r)):
        (xi, yi), (xj, yj) = r[i], r[i - 1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
    return c


def build(spec):
    doc = ezdxf.readfile(SRC / spec["dxf"])
    shapes = []
    for e in doc.modelspace():
        if e.dxftype() not in ("POLYLINE", "LWPOLYLINE", "CIRCLE", "ELLIPSE", "SPLINE"):
            continue
        r = ring_of(e)
        if len(r) >= 3:
            shapes.append({"layer": e.dxf.layer, "ring": r, "circle": e.dxftype() in ("CIRCLE", "ELLIPSE")})
    engrave_layers = set(spec.get("engrave", []))
    candidates = [s for s in shapes if s["layer"] not in engrave_layers]
    outline = max(candidates, key=lambda s: area(s["ring"]))
    x0, y0, x1, y1 = bbox(outline["ring"])
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    def to_mm(r):
        # DXF y points up; flip so y points down, origin at the outline's corner.
        return [[round(x - x0, 3), round(y1 - y, 3)] for x, y in r]

    holes, engrave, map_area = [], [], None
    for s in shapes:
        if s is outline:
            continue
        r = s["ring"]
        if s["layer"] in engrave_layers:
            sx0, sy0, sx1, sy1 = bbox(r)
            at_centre = math.hypot((sx0 + sx1) / 2 - cx, (sy0 + sy1) / 2 - cy) < 1
            (holes if s["circle"] and at_centre else engrave).append(to_mm(r))
        elif inside(outline["ring"], r[0]):
            if spec["inner"] == "map-area":
                map_area = to_mm(r) if map_area is None or area(r) > area(map_area) else map_area
            else:
                holes.append(to_mm(r))
    data = {
        "name": spec["name"],
        "w": round(x1 - x0, 2),
        "h": round(y1 - y0, 2),
        "outline": to_mm(outline["ring"]),
        "holes": holes,
        "mapArea": map_area,
        # Closed rings; holes in numbers (e.g. the 6 and 9) are separate
        # rings, so fill them with the even-odd rule.
        "engrave": engrave,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{spec['id']}.json").write_text(json.dumps(data, separators=(",", ":")))
    print(f"{spec['id']}: {data['w']} x {data['h']} mm, {len(holes)} holes, map area: {'yes' if map_area else 'no'}, {len(engrave)} engraved rings")


if __name__ == "__main__":
    for spec in TEMPLATES:
        build(spec)
