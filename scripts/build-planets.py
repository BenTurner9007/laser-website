"""Build Moon and Mars elevation tiles for the famous-places collection.

Usage:
  pip install rasterio numpy pillow scipy pyarrow shapely
  python3 scripts/build-planets.py            # all sites
  python3 scripts/build-planets.py tycho gale # just these

Sources (all public domain / CC0, read directly from USGS buckets on AWS):
  Moon  SLDEM2015 (LRO LOLA + SELENE Kaguya merge, 59 m, 60°S-60°N)
  Mars  USGS controlled MRO CTX DTMs (~20 m), mosaicked per site

Output, in the same "Terrarium" PNG tiles the Earth map uses:
  data/planets/{body}/{z}/{x}/{y}.png   elevation tiles (Web Mercator)
  data/planets/sites.json               the collection: name, body, bounds, zooms
  data/planets/{body}-features.geojson  named features (landing sites, peaks)
"""

import io
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import rasterio
import requests
import shapely
from PIL import Image
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds
from rasterio.windows import from_bounds as window_from_bounds
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/planets"
CACHE = ROOT / "scripts/source/planet-cache"  # catalogue download, not committed
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
if os.path.exists("/root/.ccr/ca-bundle.crt"):
    os.environ.setdefault("CURL_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")

BODIES = {
    "moon": {"radius": 1737400, "source": "https://asc-moon.s3.us-west-2.amazonaws.com/Lunar_LRO_LOLAKaguya_DEMmerge_60N60S_512ppd_radius.tif"},
    "mars": {"radius": 3396190, "catalogue": "https://astrogeo-ard.s3.us-west-2.amazonaws.com/collectionindices/mro_ctx_controlled_usgs_dtms.parquet"},
}

# The starter collection. box = [west, south, east, north] in degrees (east positive, -180..180).
SITES = [
    {"id": "tycho", "body": "moon", "name": "Tycho crater", "box": [-14.1, -45.3, -8.6, -41.3],
     "features": [["Tycho", -11.36, -43.31]]},
    {"id": "copernicus", "body": "moon", "name": "Copernicus crater", "box": [-22.3, 7.5, -17.9, 11.8],
     "features": [["Copernicus", -20.08, 9.62]]},
    {"id": "theophilus", "body": "moon", "name": "Theophilus & Cyrillus", "box": [22.6, -15.3, 28.7, -9.3],
     "features": [["Theophilus", 26.28, -11.45], ["Cyrillus", 24.0, -13.2]]},
    {"id": "aristarchus", "body": "moon", "name": "Aristarchus & Vallis Schröteri", "box": [-52.3, 21.5, -45.8, 27.5],
     "features": [["Aristarchus", -47.49, 23.73], ["Herodotus", -49.7, 23.2], ["Vallis Schröteri", -50.8, 26.2]]},
    {"id": "alphonsus", "body": "moon", "name": "Ptolemaeus, Alphonsus & Arzachel", "box": [-8.4, -19.9, 3.8, -7.5],
     "features": [["Ptolemaeus", -1.84, -9.16], ["Alphonsus", -3.22, -13.39], ["Arzachel", -1.93, -18.26]]},
    {"id": "apollo11", "body": "moon", "name": "Apollo 11 – Tranquility Base", "box": [22.45, -0.75, 24.75, 1.55],
     "features": [["Apollo 11", 23.473, 0.674], ["Moltke", 24.2, -0.6]]},
    {"id": "apollo15", "body": "moon", "name": "Apollo 15 – Hadley Rille", "box": [2.4, 25.0, 5.0, 27.3],
     "features": [["Apollo 15", 3.634, 26.132]]},
    {"id": "apollo17", "body": "moon", "name": "Apollo 17 – Taurus-Littrow", "box": [29.9, 19.4, 31.65, 21.0],
     "features": [["Apollo 17", 30.772, 20.191]]},
    {"id": "jezero", "body": "mars", "name": "Jezero crater (Perseverance)", "box": [76.85, 17.7, 78.25, 19.1],
     "features": [["Perseverance", 77.451, 18.445]]},
    {"id": "gale", "body": "mars", "name": "Gale crater & Mount Sharp", "box": [136.4, -6.6, 139.0, -4.0],
     "features": [["Curiosity", 137.442, -4.590], ["Mount Sharp", 137.85, -5.08]]},
    {"id": "olympus", "body": "mars", "name": "Olympus Mons caldera", "box": [-134.55, 17.7, -133.05, 19.15],
     "features": [["Olympus Mons summit", -133.8, 18.65]]},
    {"id": "gusev", "body": "mars", "name": "Gusev crater (Spirit)", "box": [174.75, -15.3, 176.2, -13.85],
     "features": [["Spirit", 175.473, -14.568], ["Husband Hill", 175.53, -14.6]]},
]

TILE = 256
FEATHER_PX = 30  # Mars: blend overlapping CTX strips over this many grid pixels
MAX_TILES_AT_TOP = 140  # caps the finest zoom per site (keeps the site small)
ZOOM_LEVELS = 5  # how many zoom levels below the finest to build


# --- Web Mercator tile maths (degrees in, tile numbers out) ---
def lon_to_x(lon, z):
    return (lon + 180) / 360 * 2**z


def lat_to_y(lat, z):
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * 2**z


def y_to_lat(y, z):
    n = math.pi - 2 * math.pi * y / 2**z
    return math.degrees(math.atan(math.sinh(n)))


def tiles_for(box, z):
    w, s, e, n = box
    return [(x, y) for x in range(int(lon_to_x(w, z)), int(lon_to_x(e, z)) + 1) for y in range(int(lat_to_y(n, z)), int(lat_to_y(s, z)) + 1)]


def top_zoom(box):
    for z in range(13, 2, -1):
        if len(tiles_for(box, z)) <= MAX_TILES_AT_TOP:
            return z
    return 3


# --- Elevation sources: each returns elev(lon_grid, lat_grid) in metres ---
class Grid:
    """A regular lon/lat grid of elevations, sampled bilinearly, with a gentle
    fade to the grid's mean beyond its edge (so tiles never show a cliff)."""

    def __init__(self, data, box):
        self.data, self.box = data, box
        self.mean = float(np.nanmean(data))

    def sample(self, lon, lat):
        w, s, e, n = self.box
        h, wd = self.data.shape
        fx = (lon - w) / (e - w) * wd - 0.5
        fy = (n - lat) / (n - s) * h - 0.5
        v = ndimage.map_coordinates(self.data, [fy.ravel(), fx.ravel()], order=1, mode="nearest").reshape(lon.shape)
        # Outside the grid, blend to the mean over 4% of its size.
        dx = np.maximum(0, np.maximum(-fx, fx - (wd - 1))) / (wd * 0.04)
        dy = np.maximum(0, np.maximum(-fy, fy - (h - 1))) / (h * 0.04)
        t = np.clip(np.maximum(dx, dy), 0, 1)
        return v * (1 - t) + self.mean * t


def moon_grid(box, res_deg):
    """Read SLDEM2015 for box at about res_deg per pixel (overviews make this cheap)."""
    r = BODIES["moon"]["radius"]
    w, s, e, n = box
    s, n = max(s, -59.99), min(n, 59.99)
    m = math.pi * r / 180  # metres per degree
    with rasterio.open("/vsicurl/" + BODIES["moon"]["source"]) as src:
        win = window_from_bounds(w * m, s * m, e * m, n * m, src.transform)
        shape = (max(2, round((n - s) / res_deg)), max(2, round((e - w) / res_deg)))
        raw = src.read(1, window=win, out_shape=shape, resampling=Resampling.bilinear).astype("float32")
        raw[raw == src.nodata] = np.nan
        elev = raw * src.scales[0]  # half-metres -> metres above the 1737.4 km sphere
    return Grid(elev, [w, s, e, n])


def mars_grid(box, res_deg, site_id):
    """Mosaic the CTX DTMs covering box onto a lon/lat grid."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cat = CACHE / "mro_ctx_controlled_usgs_dtms.parquet"
    if not cat.exists():
        cat.write_bytes(requests.get(BODIES["mars"]["catalogue"], timeout=600, verify=os.environ.get("CURL_CA_BUNDLE", True)).content)
    t = pq.read_table(cat, columns=["id", "geometry", "assets"])
    geoms = shapely.from_wkb(t.column("geometry").to_pylist())
    assets = t.column("assets").to_pylist()
    want = shapely.box(*box)
    hits = shapely.STRtree(geoms).query(want, predicate="intersects")
    # Greedy cover: biggest new area first, until the box is covered.
    hits = sorted(hits, key=lambda i: -geoms[i].intersection(want).area)[:400]
    chosen, covered = [], shapely.Polygon()
    for i in hits:
        gain = geoms[i].intersection(want).difference(covered).area
        if gain > want.area * 0.003:
            chosen.append(i)
            covered = covered.union(geoms[i].intersection(want))
        if covered.area >= want.area * 0.995 or len(chosen) >= 45:
            break
    print(f"  {site_id}: {len(chosen)} CTX DTMs cover {covered.area / want.area * 100:.0f}% of the box", flush=True)

    w, s, e, n = box
    shape = (round((n - s) / res_deg), round((e - w) / res_deg))
    dst_transform = from_bounds(w, s, e, n, shape[1], shape[0])
    total = np.zeros(shape, "float64")
    count = np.zeros(shape, "float64")
    geog = CRS.from_proj4(f"+proj=longlat +R={BODIES['mars']['radius']} +no_defs")
    for i in chosen:
        a = assets[i]
        href = next((a[k]["href"] for k in ("dtm", "geoid_adjusted_dem", "dem") if a.get(k)), None)
        if not href:
            continue
        try:
            with rasterio.open("/vsicurl/" + href) as src:
                bw, bs, be, bn = transform_bounds(geog, src.crs, w, s, e, n)
                win = window_from_bounds(bw, bs, be, bn, src.transform).intersection(rasterio.windows.Window(0, 0, src.width, src.height))
                scale = max(1, (res_deg * math.pi * BODIES["mars"]["radius"] / 180) / src.res[0])
                out_shape = (max(2, int(win.height / scale)), max(2, int(win.width / scale)))
                arr = src.read(1, window=win, out_shape=out_shape, resampling=Resampling.average).astype("float32")
                arr[(arr == src.nodata) | (arr < -1e4)] = np.nan
                # Drop a rim of pixels: DTM edges are the least reliable.
                arr[ndimage.binary_dilation(np.isnan(arr), iterations=2)] = np.nan
                wt = src.window_transform(win) * rasterio.Affine.scale(win.width / out_shape[1], win.height / out_shape[0])
                dst = np.full(shape, np.nan, "float32")
                reproject(arr, dst, src_transform=wt, src_crs=src.crs, dst_transform=dst_transform, dst_crs=geog,
                          src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
                ok = ~np.isnan(dst)
                # Line the strip up with the mosaic so far: strips can sit on
                # different height references (km apart) or differ by a few
                # metres; shift by the median difference where they overlap.
                both = ok & (count > 0.5)
                if both.sum() > 500:
                    shift = float(np.median(dst[both] - (total[both] / count[both])))
                    if abs(shift) > 1:
                        dst = dst - shift
                        print(f"    shifted {href.rsplit('/', 1)[-1][:40]} by {-shift:+.0f} m", flush=True)
                elif count.any() and ok.any():
                    print(f"    {href.rsplit('/', 1)[-1][:40]} has little overlap; kept as is", flush=True)
                # Feather: each strip counts less towards its edges, so
                # neighbouring strips blend instead of leaving a seam.
                wgt = np.clip(ndimage.distance_transform_edt(ok) / FEATHER_PX, 0, 1) ** 2
                total[ok] += dst[ok] * wgt[ok]
                count[ok] += wgt[ok]
        except Exception as err:  # one bad file shouldn't stop the site
            print(f"    skipped {href.rsplit('/', 1)[-1]}: {err}", flush=True)
    data = np.where(count > 1e-3, total / np.maximum(count, 1e-3), np.nan).astype("float32")
    holes = np.isnan(data)
    if holes.any() and (~holes).any():
        data = fill_gaps(data)
        print(f"    filled {holes.mean() * 100:.1f}% gaps", flush=True)
    return Grid(data, box)


def fill_gaps(data):
    """Fill NaN gaps smoothly from all sides: blurred averages of the known
    data (normalised convolution), coarse first, then finer near the edges."""
    known = ~np.isnan(data)
    vals = np.where(known, data, 0.0)
    out = data.copy()
    for sigma in (64, 32, 16, 8, 4, 2):
        w = ndimage.gaussian_filter(known.astype("float64"), sigma)
        v = ndimage.gaussian_filter(vals, sigma)
        est = np.where(w > 1e-6, v / np.maximum(w, 1e-6), np.nan)
        hole = np.isnan(data)
        out = np.where(hole & ~np.isnan(est), est, out)
    return np.where(np.isnan(out), np.nanmean(data), out).astype("float32")


# --- Tiles ---
def encode_terrarium(elev):
    v = np.clip(np.round(elev) + 32768, 0, 65535).astype(np.uint32)  # 1 m steps compress well
    rgb = np.stack([(v >> 8) & 255, v & 255, np.zeros_like(v)], axis=-1).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def write_tile(body, z, x, y, grid):
    lons = np.array([lon_to(x + (i + 0.5) / TILE, z) for i in range(TILE)])
    lats = np.array([y_to_lat(y + (j + 0.5) / TILE, z) for j in range(TILE)])
    lon_g, lat_g = np.meshgrid(lons, lats)
    elev = grid.sample(lon_g, lat_g)
    path = OUT / body / str(z) / str(x) / f"{y}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode_terrarium(elev))
    return elev


def lon_to(xf, z):
    return xf / 2**z * 360 - 180


def build_site(site):
    body = site["body"]
    zmax = top_zoom(site["box"])
    zmin = max(2, zmax - ZOOM_LEVELS)
    w, s, e, n = site["box"]
    # Grid a little wider than the box so frames near the edge still have data.
    pad = 0.15 * max(e - w, n - s)
    gbox = [w - pad, s - pad, e + pad, n + pad]
    res = 360 / (TILE * 2**zmax) * 0.9
    if body == "moon":
        # The Moon has data everywhere (±60°): cover whole tiles, so no edge to fade.
        t = tiles_for(gbox, zmax - 1)
        x0, x1 = min(p[0] for p in t), max(p[0] for p in t) + 1
        y0, y1 = min(p[1] for p in t), max(p[1] for p in t) + 1
        gbox = [lon_to(x0, zmax - 1), y_to_lat(y1, zmax - 1), lon_to(x1, zmax - 1), y_to_lat(y0, zmax - 1)]
    print(f"{site['id']}: zoom {zmin}-{zmax}, grid {res:.5f}°/px", flush=True)
    grid = moon_grid(gbox, res) if body == "moon" else mars_grid(gbox, res, site["id"])
    count = 0
    for z in range(zmin, zmax + 1):
        # The Moon has data everywhere (±60°), so low zooms read their own
        # wider area; Mars sites fade out beyond their mosaic.
        for x, y in tiles_for(gbox if z >= zmax - 1 else site["box"], z):
            g = grid
            if body == "moon" and z < zmax - 1:
                tb = [lon_to(x, z), y_to_lat(y + 1, z), lon_to(x + 1, z), y_to_lat(y, z)]
                g = moon_grid(tb, 360 / (TILE * 2**z) * 0.9)
            write_tile(body, z, x, y, g)
            count += 1
    feats = []
    for name, lon, lat in site["features"]:
        h = float(grid.sample(np.array([[lon]]), np.array([[lat]]))[0, 0])
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                      "properties": {"name": name, "h": round(h), "site": site["id"], "lists": ",features,"}})
    print(f"  {count} tiles", flush=True)
    return {"id": site["id"], "body": body, "name": site["name"], "box": site["box"], "minzoom": zmin, "maxzoom": zmax,
            "elevation": [round(float(np.nanmin(grid.data))), round(float(np.nanmax(grid.data)))]}, feats


def main(only):
    OUT.mkdir(parents=True, exist_ok=True)
    sites_file = OUT / "sites.json"
    known = {s["id"]: s for s in json.loads(sites_file.read_text())["sites"]} if sites_file.exists() else {}
    features = {}
    for b in BODIES:
        f = OUT / f"{b}-features.geojson"
        features[b] = [x for x in json.loads(f.read_text())["features"]] if f.exists() else []
    for site in SITES:
        if only and site["id"] not in only:
            continue
        info, feats = build_site(site)
        known[site["id"]] = info
        features[site["body"]] = [f for f in features[site["body"]] if f["properties"]["site"] != site["id"]] + feats
    order = [s["id"] for s in SITES]
    out = {"bodies": {b: {"radius": v["radius"], "maxzoom": max([s["maxzoom"] for s in known.values() if s["body"] == b] or [10])} for b, v in BODIES.items()},
           "sites": sorted(known.values(), key=lambda s: order.index(s["id"]) if s["id"] in order else 99)}
    sites_file.write_text(json.dumps(out, indent=1))
    for b, feats in features.items():
        (OUT / f"{b}-features.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))


if __name__ == "__main__":
    main(set(sys.argv[1:]))
