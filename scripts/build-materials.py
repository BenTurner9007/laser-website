"""Build data/materials.json from a supplier price list (Kitronik's export).

Usage: pip install openpyxl; python3 scripts/build-materials.py [path/to.xlsx]

Reads the "Plywood" sheet (columns: Stock code, Product, Material,
Thickness (mm), Length (mm), Width (mm), Price ex VAT (£), Product URL) and
groups the sheets by material and thickness. Samples and packs are skipped.
"""

import json
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "scripts/source/kitronik-laser-plywood.xlsx"
OUT = ROOT / "data/materials.json"

# Display names and 3D preview look for each supplier material.
LOOKS = {
    "Poplar (Panguaneta, AB/AB)": ("Poplar plywood (AB/AB)", "poplar"),
    "Poplar (B/BB)": ("Poplar plywood (B/BB)", "poplar"),
    "Birch-faced poplar": ("Birch-faced poplar", "birch"),
    "Maple-faced poplar": ("Maple-faced poplar", "maple"),
    "Birch (BR grade)": ("Birch plywood (BR grade)", "birch"),
    "Ceiba (B/BB)": ("Ceiba plywood", "ceiba"),
}

ws = openpyxl.load_workbook(src, data_only=True)["Plywood"]
rows = list(ws.iter_rows(values_only=True))
col = {name: i for i, name in enumerate(rows[0])}
materials = {}
for r in rows[1:]:
    supplier = r[col["Material"]]
    if supplier not in LOOKS or not r[col["Thickness (mm)"]] or not r[col["Length (mm)"]]:
        continue  # samples, packs, unknown materials
    name, look = LOOKS[supplier]
    m = materials.setdefault(name, {"name": name, "supplierMaterial": supplier, "look": look, "thicknesses": {}})
    t = float(r[col["Thickness (mm)"]])
    m["thicknesses"].setdefault(str(t).rstrip("0").rstrip("."), []).append({
        "code": str(r[col["Stock code"]]),
        "w": int(r[col["Length (mm)"]]),
        "h": int(r[col["Width (mm)"]]),
        "price": round(float(r[col["Price ex VAT (£)"]]), 2),
        "url": r[col["Product URL"]],
    })

out = []
for m in materials.values():
    m["thicknesses"] = [
        {"mm": float(t), "sheets": sorted(s, key=lambda x: x["w"] * x["h"])}
        for t, s in sorted(m["thicknesses"].items(), key=lambda kv: float(kv[0]))
    ]
    out.append(m)
data = {
    "supplier": "Kitronik",
    "source": src.name,
    "vat": 0.2,
    "materials": out,
}
OUT.write_text(json.dumps(data, indent=1))
for m in out:
    print(m["name"], [(t["mm"], len(t["sheets"])) for t in m["thicknesses"]])
