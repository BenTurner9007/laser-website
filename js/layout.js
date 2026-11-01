// Turns a map frame into a laser-ready SVG layout.
//
// Elevation comes from the open Terrarium DEM tiles (AWS Terrain Tiles).
// Contours are traced with d3-contour as filled regions, so each contour
// level is a closed shape that can be cut from one sheet and stacked.

/* global d3, polygonClipping */

import { SHAPES, DEFAULT_SHAPE, placeShape } from "./shapes.js";
import { loadFonts, textRings } from "./text.js";
import { routeBand } from "./route.js";
import { WATER_KINDS, ROAD_KINDS } from "./water.js";
import { splitIntoPieces, numberPieces } from "./pieces.js";
import { nestPieces } from "./nest.js";

export const DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
// Elevation source: Earth by default; the Moon and Mars pass their own
// (tiles in data/planets/, heights can be negative, there is no sea).
export const EARTH_DEM = { url: DEM_URL, maxzoom: 15, sea: true };
const TILE = 256;

// Laser colour conventions (LightBurn / most laser software map colour to operation).
export const COLOURS = {
  cut: "#ff0000",
  guide: "#0000ff",
  engrave: "#000000",
  water: "#00e000",
  roads: "#00a0a0", // road score lines
  number: "#ff8000", // assembly numbers, hidden under the piece above
  numberVisible: "#ff00ff", // ids of pieces with nothing on top (would show)
  sheet: "#999999", // sheet edges, for reference only
};
const NUMBER_MM = 4; // assembly number size

const MAX_GRID_PX = 1400; // longest side of the elevation grid
const MAX_TILES = 120;
const MIN_FEATURE_MM2 = 4; // drop islands/holes smaller than ~2 x 2 mm, too fragile to cut
const ENGRAVE_MIN_MM2 = 0.01; // engraving can be fine (the dot on an "i")
const SIMPLIFY_MM = 0.05;

// --- Web Mercator helpers (world pixel coordinates at zoom z) ---
const worldSize = (z) => TILE * 2 ** z;
const lngToX = (lng, z) => ((lng + 180) / 360) * worldSize(z);
const latToY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(z);
};

function pickZoom(b, maxzoom) {
  for (let z = maxzoom; z >= 3; z--) {
    const w = lngToX(b.east, z) - lngToX(b.west, z);
    const h = latToY(b.south, z) - latToY(b.north, z);
    const tiles = (Math.ceil(w / TILE) + 1) * (Math.ceil(h / TILE) + 1);
    if (Math.max(w, h) <= MAX_GRID_PX && tiles <= MAX_TILES) return z;
  }
  return 3;
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // missing tile = treat as sea level
    img.src = url;
  });
}

/** Fetch DEM tiles covering the bounds and return an elevation grid in metres. */
export async function fetchElevationGrid(bounds, onProgress = () => {}, dem = EARTH_DEM) {
  const z = pickZoom(bounds, dem.maxzoom);
  const x0 = lngToX(bounds.west, z), x1 = lngToX(bounds.east, z);
  const y0 = latToY(bounds.north, z), y1 = latToY(bounds.south, z);
  const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x1 - 1e-9) / TILE);
  const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y1 - 1e-9) / TILE);

  const canvas = document.createElement("canvas");
  canvas.width = (tx1 - tx0 + 1) * TILE;
  canvas.height = (ty1 - ty0 + 1) * TILE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) jobs.push({ tx, ty });
  }
  let done = 0;
  await Promise.all(
    jobs.map(async ({ tx, ty }) => {
      const url = dem.url.replace("{z}", z).replace("{x}", tx).replace("{y}", ty);
      const img = await loadImage(url);
      if (img) ctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE);
      else if (dem.sea) {
        // Terrarium value for 0 m: R=128, G=0, B=0
        ctx.fillStyle = "rgb(128,0,0)";
        ctx.fillRect((tx - tx0) * TILE, (ty - ty0) * TILE, TILE, TILE);
      }
      onProgress(++done / jobs.length);
    })
  );

  const ox = Math.floor(x0 - tx0 * TILE), oy = Math.floor(y0 - ty0 * TILE);
  const gw = Math.max(2, Math.round(x1 - x0)), gh = Math.max(2, Math.round(y1 - y0));
  const px = ctx.getImageData(ox, oy, gw, gh).data;
  const values = new Float64Array(gw * gh);
  let sum = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    const e = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    if (dem.sea) values[i] = Math.max(0, e); // flatten the sea / bathymetry to 0 m
    else if (px[i * 4 + 3] === 0) values[i] = NaN; // no tile here
    else {
      values[i] = e;
      sum += e;
      n++;
    }
  }
  // Moon/Mars: anything outside the built tiles becomes a flat floor.
  if (!dem.sea) for (let i = 0; i < values.length; i++) if (Number.isNaN(values[i])) values[i] = n ? sum / n : 0;
  return { values, width: gw, height: gh, zoom: z };
}

/** Separable box blur, repeated, approximating a Gaussian. */
function smooth(values, w, h, radius, passes = 2) {
  if (radius < 1) return values;
  let src = Float64Array.from(values);
  let tmp = new Float64Array(src.length);
  const blur1d = (from, to, n, stride, count, step) => {
    for (let line = 0; line < count; line++) {
      const base = line * step;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += from[base + Math.min(n - 1, Math.max(0, k)) * stride];
      for (let i = 0; i < n; i++) {
        to[base + i * stride] = sum / (2 * radius + 1);
        const add = Math.min(n - 1, i + radius + 1), sub = Math.max(0, i - radius);
        sum += from[base + add * stride] - from[base + sub * stride];
      }
    }
  };
  for (let p = 0; p < passes; p++) {
    blur1d(src, tmp, w, 1, h, w); // rows
    blur1d(tmp, src, h, w, w, 1); // columns
  }
  return src;
}

// --- Geometry helpers (all in output millimetres) ---
const boxOf = (ring) => ({
  x0: Math.min(...ring.map((p) => p[0])), y0: Math.min(...ring.map((p) => p[1])),
  x1: Math.max(...ring.map((p) => p[0])), y1: Math.max(...ring.map((p) => p[1])),
});

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}

function simplify(points, tol) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Scale a d3 MultiPolygon to millimetres, dropping fragile bits and simplifying.
// Returns polygons as [outerRing, ...holeRings].
function cleanPolygons(mp, sx, sy) {
  const out = [];
  for (const polygon of mp.coordinates) {
    const rings = [];
    for (let k = 0; k < polygon.length; k++) {
      const ring = polygon[k].map(([x, y]) => [x * sx, y * sy]);
      if (ringArea(ring) < MIN_FEATURE_MM2) {
        if (k === 0) break; // outer ring too small: skip the polygon and its holes
        continue;
      }
      rings.push(simplify(ring, SIMPLIFY_MM));
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

// --- Board templates (clock, bookmark, coasters; see scripts/build-templates.py) ---
// polygon-clipping repeats each ring's first point at the end; drop it and tiny bits.
function tidy(mp, minArea = MIN_FEATURE_MM2) {
  const out = [];
  for (const polygon of mp) {
    const rings = [];
    for (let k = 0; k < polygon.length; k++) {
      const ring = polygon[k].slice(0, -1);
      if (ring.length < 3 || ringArea(ring) < minArea) {
        if (k === 0) break;
        continue;
      }
      rings.push(ring);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

const clip = (op, a, b, minArea) => {
  if (!a.length || (op === "intersection" && !b.length)) return [];
  return tidy(b.length ? polygonClipping[op](a, b) : polygonClipping.union(a), minArea);
};

/**
 * A template's board (outline minus holes), the region the contour map may
 * fill (its map area, or the whole board), and its own engraving, in layout
 * millimetres.
 */
function templateGeometry(t, W, H) {
  const kx = W / t.w, ky = H / t.h;
  const at = (ring) => ring.map(([x, y]) => [x * kx, y * ky]);
  const holes = (t.holes || []).map(at);
  const board = [[at(t.outline), ...holes]];
  const mapRegion = t.mapArea ? tidy(polygonClipping.difference([[at(t.mapArea)]], ...holes.map((h) => [[h]])), 0) : board;
  const rings = (t.engrave || []).map(at);
  // XOR turns the separate rings into shapes with holes (the inside of a 6 or 9).
  const engrave = rings.length ? tidy(polygonClipping.xor(...rings.map((ring) => [[[...ring, ring[0]]]])), ENGRAVE_MIN_MM2) : [];
  return { board, mapRegion, engrave };
}

// Even-odd point test across polygons ([outer, ...holes] each).
function inPolys(polys, [x, y]) {
  for (const poly of polys) {
    let c = false;
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
    }
    if (c) return true;
  }
  return false;
}

const lineLength = (l) => l.reduce((n, p, i) => (i ? n + Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0), 0);

/**
 * Which layer is on top at each point: draws every layer (holes and all)
 * into an off-screen canvas, each in a colour holding its index. Returns
 * get(x, y) in mm, or -1 off the board.
 */
function layerMask(layers, W, H) {
  const k = Math.min(5, 2400 / Math.max(W, H)); // pixels per mm
  const c = document.createElement("canvas");
  c.width = Math.ceil(W * k);
  c.height = Math.ceil(H * k);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "rgb(0,0,0)";
  g.fillRect(0, 0, c.width, c.height);
  g.scale(k, k);
  layers.forEach((l, i) => {
    g.fillStyle = `rgb(${i + 1},0,0)`;
    g.fill(new Path2D(l.d), "evenodd");
  });
  const px = g.getImageData(0, 0, c.width, c.height).data;
  return (x, y) => {
    const ix = Math.floor(x * k), iy = Math.floor(y * k);
    if (ix < 0 || iy < 0 || ix >= c.width || iy >= c.height) return -1;
    return px[(iy * c.width + ix) * 4] - 1;
  };
}

/** Cut lines (mm) into runs by the layer on top, stepping every ~0.25 mm. */
function splitByLayer(lines, mask, step = 0.25) {
  const byLayer = new Map();
  const add = (layer, run) => {
    if (layer < 0 || run.length < 2) return;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(simplify(run, SIMPLIFY_MM));
  };
  for (const line of lines) {
    // Points every ~step mm along the line.
    const pts = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const [x1, y1] = line[i - 1], [x2, y2] = line[i];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
      for (let j = 1; j <= n; j++) pts.push([x1 + ((x2 - x1) * j) / n, y1 + ((y2 - y1) * j) / n]);
    }
    let run = [], layer = null;
    for (const p of pts) {
      const l = mask(p[0], p[1]);
      if (l !== layer) {
        // Join the runs at the midpoint so there's no gap at the step.
        const prev = run[run.length - 1];
        const mid = prev ? [(prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2] : null;
        if (mid) run.push(mid);
        add(layer, run);
        run = mid ? [mid] : [];
        layer = l;
      }
      run.push(p);
    }
    add(layer, run);
  }
  return byLayer;
}

const linesToPathOf = (lines) => lines.map((l) => "M" + l.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")).join("");

/** Cut out the parts of lines (mm) that pass through any of the boxes. */
function linesOutsideBoxes(lines, boxes) {
  const out = [];
  for (const line of lines) {
    let run = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1], [bx, by] = line[i];
      // Parameter ranges [t0, t1] of this segment inside each box (Liang-Barsky).
      const inside = [];
      for (const b of boxes) {
        let t0 = 0, t1 = 1;
        const dx = bx - ax, dy = by - ay;
        const edges = [[-dx, ax - b.x0], [dx, b.x1 - ax], [-dy, ay - b.y0], [dy, b.y1 - ay]];
        let hit = true;
        for (const [p, q] of edges) {
          if (p === 0) {
            if (q < 0) { hit = false; break; }
          } else {
            const r = q / p;
            if (p < 0) t0 = Math.max(t0, r);
            else t1 = Math.min(t1, r);
            if (t0 > t1) { hit = false; break; }
          }
        }
        if (hit && t1 > t0) inside.push([t0, t1]);
      }
      if (!inside.length) {
        run.push(line[i]);
        continue;
      }
      inside.sort((p, q) => p[0] - q[0]);
      const at = (t) => [ax + (bx - ax) * t, ay + (by - ay) * t];
      let t = 0;
      for (const [s, e] of inside) {
        if (s > t) run.push(at(s));
        if (run.length > 1) out.push(run);
        t = Math.max(t, e);
        run = [at(t)];
      }
      if (t < 1) run.push(line[i]);
      else run = [line[i]];
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

// Keep only the parts of lines (in mm) that come near the board.
function trimLines(lines, W, H, margin) {
  const near = ([x, y]) => x >= -margin && y >= -margin && x <= W + margin && y <= H + margin;
  const out = [];
  for (const line of lines) {
    let run = [];
    for (let i = 0; i < line.length; i++) {
      // Keep a point if it, or a neighbour, is near the board, so segments crossing the edge survive.
      if (near(line[i]) || (i > 0 && near(line[i - 1])) || (i < line.length - 1 && near(line[i + 1]))) run.push(line[i]);
      else if (run.length) {
        if (run.length > 1) out.push(run);
        run = [];
      }
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

// One filled path per shape: shapes that overlap (a route crossing a label)
// then both engrave, instead of cancelling out under the even-odd rule.
const fillEach = (polys, colour) => polys.map((p) => `<path d="${polygonsToPath([p])}" fill="${colour}" fill-rule="evenodd"/>\n`).join("");

// Polygons as polygon-clipping gives them (or as built here), with any
// repeated closing point dropped and tiny bits removed.
function closeTidy(mp) {
  const out = [];
  for (const polygon of mp) {
    const rings = [];
    for (let k = 0; k < polygon.length; k++) {
      let ring = polygon[k];
      const [a, z] = [ring[0], ring[ring.length - 1]];
      if (ring.length > 1 && a[0] === z[0] && a[1] === z[1]) ring = ring.slice(0, -1);
      if (ring.length < 3 || ringArea(ring) < ENGRAVE_MIN_MM2) {
        if (k === 0) break;
        continue;
      }
      rings.push(ring);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

// Sutherland-Hodgman: a ring cut to an axis-aligned box (fine for cutting a
// small mark that lies inside the box against it).
function clipRingToBox(ring, b) {
  let pts = ring;
  const edges = [
    [(p) => p[0] >= b.x0, (p, q) => [b.x0, p[1] + ((q[1] - p[1]) * (b.x0 - p[0])) / (q[0] - p[0])]],
    [(p) => p[0] <= b.x1, (p, q) => [b.x1, p[1] + ((q[1] - p[1]) * (b.x1 - p[0])) / (q[0] - p[0])]],
    [(p) => p[1] >= b.y0, (p, q) => [p[0] + ((q[0] - p[0]) * (b.y0 - p[1])) / (q[1] - p[1]), b.y0]],
    [(p) => p[1] <= b.y1, (p, q) => [p[0] + ((q[0] - p[0]) * (b.y1 - p[1])) / (q[1] - p[1]), b.y1]],
  ];
  for (const [inside, cross] of edges) {
    if (!pts.length) break;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) out.push(cross(p, q));
    }
    pts = out;
  }
  return pts;
}

const polygonsToPath = (polys) =>
  polys.flat().map((r) => "M" + r.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L") + "Z").join("");

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

/**
 * Build the layout.
 * @param {object} o
 * @param {{west:number,south:number,east:number,north:number}} o.bounds
 * @param {number} o.widthMm, o.heightMm
 * @param {number} o.interval   contour interval in metres
 * @param {number} o.smoothing  0..3
 * @param {"layered"|"engraved"} o.style
 * @param {Array<{name:string,h:number,lng:number,lat:number}>} o.peaks
 * @param {"name"|"name-height"|"none"} o.labelMode
 * @param {number} o.fontMm
 * @param {boolean} o.guides   engrave each next layer's outline as a glue guide
 * @param {object} [o.template]  board template, e.g. data/clock-305.json
 * @param {Array<{lng:number,lat:number,shape:string,label:string}>} [o.places]  customers' special places
 * @param {number} [o.placeMm]  special place marker size
 * @param {{lines:number[][][], widthMm:number, style:"solid"|"dashed"}} [o.route]  hiking route, lines of [lng, lat]
 * @param {Object<string, number[][][]>} [o.water]  lines of [lng, lat] by kind (see WATER_KINDS)
 * @param {Object<string, number[][][]>} [o.roads]  lines of [lng, lat] by kind (see ROAD_KINDS)
 * @param {Array<{name:string, kind:"c"|"t"|"v", lng:number, lat:number}>} [o.towns]  place names to label
 * @param {number} [o.townFontMm]  place name text size
 * @param {boolean} [o.contours]  false for a flat board with no contour lines
 * @param {boolean} [o.labelBoxes]  clear contours (and water) from a box behind each peak label
 * @param {{url:string, maxzoom:number, sea:boolean}} [o.dem]  elevation tiles (Earth by default)
 */
export async function buildLayout(o, onProgress) {
  const dem = o.dem || EARTH_DEM;
  const [grid] = await Promise.all([fetchElevationGrid(o.bounds, onProgress, dem), loadFonts()]);
  const { width: gw, height: gh, zoom } = grid;
  const radius = Math.round(o.smoothing * Math.max(1, gw / 350));
  const values = smooth(grid.values, gw, gh, radius);
  // The blur's running sums leave rounding noise (±1e-13) on flat sea; snap it
  // back to 0 so no contour is traced through the noise.
  if (dem.sea) for (let i = 0; i < values.length; i++) if (values[i] < 1e-6) values[i] = 0;

  let minE = Infinity, maxE = -Infinity;
  for (const v of values) { if (v < minE) minE = v; if (v > maxE) maxE = v; }

  // No contours: a flat board, so no levels (and no contour lines).
  const levels = [];
  if (o.contours !== false) for (let t = Math.floor(minE / o.interval + 1) * o.interval; t <= maxE; t += o.interval) levels.push(t);

  const W = o.widthMm, H = o.heightMm, sx = W / gw, sy = H / gh;
  const contours = d3.contours().size([gw, gh]).smooth(true).thresholds(levels)(values);
  const tpl = o.template ? templateGeometry(o.template, W, H) : null;
  const boardPolys = tpl ? tpl.board : [[[[0, 0], [W, 0], [W, H], [0, H]]]];
  const outline = polygonsToPath(boardPolys);
  // Layer 0 is the base board; layer i>0 is the area at or above levels[i-1].
  const layers = [{ elevation: Math.round(minE), d: outline, polys: boardPolys }].concat(
    contours.map((c) => {
      let polys = cleanPolygons(c, sx, sy);
      if (tpl) polys = clip("intersection", polys, tpl.mapRegion);
      return { elevation: c.value, d: polygonsToPath(polys), polys };
    })
  );
  while (layers.length > 1 && !layers[layers.length - 1].polys.length) layers.pop();

  // Millimetre position of a lng/lat, and whether it is on the board.
  const z = zoom;
  const fx0 = lngToX(o.bounds.west, z), fy0 = latToY(o.bounds.north, z);
  const fx1 = lngToX(o.bounds.east, z), fy1 = latToY(o.bounds.south, z);
  const toMm = ([lng, lat]) => [((lngToX(lng, z) - fx0) / (fx1 - fx0)) * W, ((latToY(lat, z) - fy0) / (fy1 - fy0)) * H];
  // On the map: inside the frame, or the template's map region with a margin.
  const AROUND = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
  const onBoard = ([x, y], margin = 0) =>
    tpl ? AROUND.every(([dx, dy]) => inPolys(tpl.mapRegion, [x + dx * margin, y + dy * margin])) : x >= 0 && y >= 0 && x < W && y < H;
  const mapRegion = tpl ? tpl.mapRegion : boardPolys;
  // Separate rings (glyph outlines, holes) to filled shapes.
  const solid = (rings) => (rings.length ? polygonClipping.xor(...rings.map((r) => [[r]])) : []);

  // Everything engraved on the map, as shapes: peak labels, special places, route.
  const marks = [];

  // Labels are placed one at a time so none overlap: special places first
  // (the customer chose them), then peaks, highest first. Each label tries
  // spots round its marker and takes the first that is clear and on the map;
  // if none is, the name is left off (and counted) rather than overprinted.
  const taken = []; // boxes {x0, y0, x1, y1} in mm: markers, text, template engraving
  const GAP = 0.6; // mm kept between labels
  const hits = (q) => taken.some((t) => q.x0 - GAP < t.x1 && t.x0 - GAP < q.x1 && q.y0 - GAP < t.y1 && t.y0 - GAP < q.y1);
  const onMap = (q) => [[q.x0, q.y0], [q.x1, q.y0], [q.x0, q.y1], [q.x1, q.y1]].every((pt) => onBoard(pt));
  if (tpl) for (const poly of tpl.engrave) taken.push(boxOf(poly[0])); // e.g. clock numbers
  const prefer = (x) => (x < W * 0.7 ? ["E", "W", "NE", "SE", "NW", "SW", "N", "S"] : ["W", "E", "NW", "SW", "NE", "SE", "N", "S"]);
  // Text beside a marker centred on (cx, cy) with half-size (hw, hh).
  const placeText = (text, size, weight, cx, cy, hw, hh, order) => {
    const w = textRings(text, 0, 0, size, { weight }).width;
    const asc = size * 0.78, h = asc + size * 0.24, g = size * 0.35;
    const spots = {
      E: [cx + hw + g, cy - h / 2], W: [cx - hw - g - w, cy - h / 2],
      NE: [cx + hw * 0.4, cy - hh - g * 0.6 - h], SE: [cx + hw * 0.4, cy + hh + g * 0.6],
      NW: [cx - hw * 0.4 - w, cy - hh - g * 0.6 - h], SW: [cx - hw * 0.4 - w, cy + hh + g * 0.6],
      N: [cx - w / 2, cy - hh - g * 0.6 - h], S: [cx - w / 2, cy + hh + g * 0.6],
      C: [cx - w / 2, cy - h / 2],
    };
    for (const k of order) {
      const [x0, y0] = spots[k];
      const box = { x0, y0, x1: x0 + w, y1: y0 + h };
      if (onMap(box) && !hits(box)) {
        taken.push(box);
        return { box, rings: textRings(text, x0, y0 + asc, size, { weight }).rings };
      }
    }
    return null;
  };
  let labelsLeftOff = 0;

  // Special places: the chosen shape with a bold label beside it.
  const places = [];
  for (const p of o.places || []) {
    const [x, y] = toMm([p.lng, p.lat]);
    if (!onBoard([x, y])) continue;
    const shape = SHAPES[p.shape] ? p.shape : DEFAULT_SHAPE, s = o.placeMm || 8;
    const cy = y + (0.5 - SHAPES[shape].anchor[1]) * s;
    places.push({ ...p, shape, x, y, cy, sizeMm: s });
    marks.push(solid(placeShape(shape, x, y, s)));
    taken.push({ x0: x - s / 2, y0: cy - s / 2, x1: x + s / 2, y1: cy + s / 2 });
  }
  for (const p of places) {
    if (!p.label) continue;
    const r = placeText(p.label, o.fontMm * 1.2, "bold", p.x, p.cy, p.sizeMm / 2, p.sizeMm / 2, prefer(p.x));
    if (r) marks.push(solid(r.rings));
    else labelsLeftOff++;
  }

  // Place names (no marker): centred on the place if there is room, else
  // just off it. Cities are bold and a little larger, villages smaller.
  let townsPlaced = 0;
  const TOWN_STYLE = { c: [1.15, "bold"], t: [1, "regular"], v: [0.85, "regular"] };
  const placeTowns = (kinds) => {
    for (const t of o.towns || []) {
      if (!kinds.includes(t.kind)) continue;
      const [x, y] = toMm([t.lng, t.lat]);
      if (!onBoard([x, y])) continue;
      const [k, weight] = TOWN_STYLE[t.kind];
      const r = placeText(t.name, (o.townFontMm || 3.5) * k, weight, x, y, 0, 0, ["C", "N", "S", "E", "W"]);
      if (!r) {
        labelsLeftOff++;
        continue;
      }
      marks.push(solid(r.rings));
      townsPlaced++;
    }
  };
  placeTowns("c"); // cities before peaks, towns and villages after

  // Peaks: a small triangle on the summit with the name beside it.
  let peaksPlaced = 0;
  const labelBoxes = []; // { x0, y0, x1, y1 } in mm, when o.labelBoxes
  if (o.labelMode !== "none") {
    const m = o.fontMm * 0.45; // marker half-size
    const ranked = o.peaks
      .map((p) => ({ ...p, at: toMm([p.lng, p.lat]) }))
      .filter((p) => onBoard(p.at, o.fontMm))
      .sort((a, b) => (b.h ?? 0) - (a.h ?? 0));
    // Highest first, each name straight after its marker, so the big summits
    // always get named; a lower top whose marker would land on a name, a
    // higher summit or a special place is left off entirely.
    for (const p of ranked) {
      const [x, y] = p.at;
      const box = { x0: x - m, y0: y - m, x1: x + m, y1: y + m * 0.8 };
      if (hits(box)) continue;
      taken.push(box);
      peaksPlaced++;
      marks.push([[[x - m, y + m * 0.8], [x, y - m], [x + m, y + m * 0.8]]]);
      const text = o.labelMode === "name-height" ? `${p.name} ${p.h} m` : p.name;
      const r = placeText(text, o.fontMm, "regular", x, y - m * 0.1, m, m * 0.9, prefer(x));
      if (!r) {
        labelsLeftOff++;
        continue;
      }
      marks.push(solid(r.rings));
      // Just round the text (caps to descenders), with a little padding.
      const pad = 0.5;
      if (o.labelBoxes) labelBoxes.push({ x0: r.box.x0 - pad, x1: r.box.x1 + pad, y0: r.box.y0 - pad, y1: r.box.y1 + pad });
    }
  }

  placeTowns("tv");

  // Label boxes on a layered map: each box becomes a flat recess at the
  // lowest ground under it, cut out of every layer above, so the name sits
  // on one flat surface with no layer edges running through it.
  if (labelBoxes.length && o.style !== "engraved") {
    const lowestLayer = (b) => {
      let min = Infinity;
      for (let gy = Math.max(0, Math.floor(b.y0 / sy)); gy <= Math.min(gh - 1, Math.ceil(b.y1 / sy)); gy++) {
        for (let gx = Math.max(0, Math.floor(b.x0 / sx)); gx <= Math.min(gw - 1, Math.ceil(b.x1 / sx)); gx++) min = Math.min(min, values[gy * gw + gx]);
      }
      let layer = 0;
      while (layer < levels.length && levels[layer] <= min) layer++;
      return layer;
    };
    const boxes = labelBoxes.map((b) => ({ poly: [[[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]], layer: lowestLayer(b) }));
    for (let i = 1; i < layers.length; i++) {
      const cut = boxes.filter((b) => b.layer < i).map((b) => b.poly);
      if (!cut.length) continue;
      layers[i].polys = clip("difference", layers[i].polys, polygonClipping.union(...cut));
      layers[i].d = polygonsToPath(layers[i].polys);
    }
    while (layers.length > 1 && !layers[layers.length - 1].polys.length) layers.pop();
  }

  // Hiking route: a band along the line, solid or dashed.
  let routeOnBoard = false;
  if (o.route?.lines?.length) {
    const band = routeBand(o.route.lines.map((l) => l.map(toMm)), o.route.widthMm, o.route.style);
    routeOnBoard = clip("intersection", band, mapRegion, ENGRAVE_MIN_MM2).length > 0;
    marks.push(band);
  }

  // Each part of every mark is engraved on whichever layer is on top at that
  // spot, so labels crossing several contour levels stay readable when stacked.
  // Map marks stay inside the map region; a template's own engraving (clock
  // numbers) may sit anywhere on the board.
  // Marks are kept as separate shapes (labels no longer overlap, so merging
  // them all, which was very slow on busy maps, isn't needed); only a mark
  // that reaches the edge of its region is trimmed, on its own.
  const within = (polys, region) =>
    polys.flatMap((poly) => {
      const b = boxOf(poly[0]);
      const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]];
      return corners.every((c) => inPolys(region, c)) ? [poly] : clip("intersection", [poly], region, ENGRAVE_MIN_MM2);
    });
  const mapMarks = within(marks.flatMap((m) => closeTidy(m)), mapRegion);
  const tplMarks = tpl?.engrave.length ? within(tpl.engrave, boardPolys) : [];
  const allMarks = [...mapMarks, ...tplMarks];
  const engrave = [];
  if (allMarks.length && o.style === "engraved") engrave.push({ layer: 0, polys: allMarks });
  else if (allMarks.length) {
    // Look each mark up in a picture of the layers: most sit wholly on one
    // layer and are assigned directly. Only marks crossing a layer edge are
    // cut, against just the nearby parts of those layers (cutting everything
    // against whole layers took tens of seconds on big, busy maps).
    const mask = layerMask(layers, W, H);
    const byLayer = new Map();
    const add = (i, polys) => {
      if (!polys.length) return;
      if (!byLayer.has(i)) byLayer.set(i, []);
      byLayer.get(i).push(...polys);
    };
    // The parts of a layer inside box b: polygons and holes that reach it,
    // each ring trimmed to the box, so cutting a small mark stays cheap.
    const overlapsBox = (r, b) => {
      const q = boxOf(r);
      return q.x0 <= b.x1 && q.x1 >= b.x0 && q.y0 <= b.y1 && q.y1 >= b.y0;
    };
    const near = (polys, b) =>
      polys
        .filter((p) => overlapsBox(p[0], b))
        .map((p) => p.filter((r, k) => k === 0 || overlapsBox(r, b)).map((r) => clipRingToBox(r, b)).filter((r) => r.length >= 3))
        .filter((p) => p.length && p[0].length >= 3);
    for (const mark of allMarks) {
      const b0 = boxOf(mark[0]), pad = 0.4;
      const b = { x0: b0.x0 - pad, y0: b0.y0 - pad, x1: b0.x1 + pad, y1: b0.y1 + pad };
      let lo = Infinity, hi = -Infinity;
      const step = 0.2;
      for (let y = b.y0; y <= b.y1; y += step) {
        for (let x = b.x0; x <= b.x1; x += step) {
          const l = mask(x, y);
          if (l < 0) continue;
          if (l < lo) lo = l;
          if (l > hi) hi = l;
        }
      }
      if (lo === Infinity) continue;
      if (lo === hi) {
        add(lo, [mark]);
        continue;
      }
      for (let i = lo; i <= hi; i++) {
        const onLayer = i === 0 ? [mark] : clip("intersection", [mark], near(layers[i].polys, b), ENGRAVE_MIN_MM2);
        if (!onLayer.length) continue;
        const visible = layers[i + 1] ? clip("difference", onLayer, near(layers[i + 1].polys, b), ENGRAVE_MIN_MM2) : onLayer;
        add(i, visible);
      }
    }
    for (const [layer, polys] of [...byLayer].sort((a, c) => a[0] - c[0])) engrave.push({ layer, polys });
  }
  const engravePath = (i) =>
    engrave.filter((e) => e.layer === i).map((e) => fillEach(e.polys, COLOURS.engrave)).join("");

  // Water: lake shores, rivers, streams and coastline as score lines, each
  // stretch on whichever layer is on top there (looked up in a layer mask,
  // which stays fast with thousands of water points).
  // Roads go the same way, in their own colour.
  const water = [];
  const lineKinds = [
    ...WATER_KINDS.filter((k) => o.water?.[k.id]?.length).map((k) => ({ ...k, group: "water", lines: o.water[k.id] })),
    ...ROAD_KINDS.filter((k) => o.roads?.[k.id]?.length).map((k) => ({ ...k, group: "roads", lines: o.roads[k.id] })),
  ];
  if (lineKinds.length) {
    // Water stays inside the map region (not on a coaster's plain border).
    const maskLayers = (o.style === "engraved" ? layers.slice(0, 1) : layers).map((l, i) => (i === 0 ? { d: polygonsToPath(mapRegion) } : l));
    const mask = layerMask(maskLayers, W, H);
    for (const kind of lineKinds) {
      const lines = trimLines(kind.lines.map((l) => l.map(toMm)), W, H, 1).filter((l) => lineLength(l) >= 2);
      const clear = labelBoxes.length ? linesOutsideBoxes(lines, labelBoxes) : lines;
      for (const [layer, runs] of splitByLayer(clear, mask)) water.push({ layer, group: kind.group, kind: kind.id, widthMm: kind.widthMm, lines: runs });
    }
  }
  // Engraved boards: contour lines as open lines, with the label boxes left clear.
  const contourLines = layers.slice(1).flatMap((l) => l.polys.flat().map((r) => [...r, r[0]]));
  const contourPath = linesToPathOf(labelBoxes.length ? linesOutsideBoxes(contourLines, labelBoxes) : contourLines);
  const linesToPath = (lines) => lines.map((l) => "M" + l.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")).join("");
  const scorePath = (lines, group) => (lines?.length ? `<path d="${linesToPath(lines)}" fill="none" stroke="${COLOURS[group]}" stroke-width="0.1"/>\n` : "");
  const waterPath = (i) =>
    ["water", "roads"].map((g) => scorePath(water.filter((w) => w.layer === i && w.group === g).flatMap((w) => w.lines), g)).join("");

  const meta = {
    bounds: o.bounds, widthMm: W, heightMm: H, interval: o.interval, smoothing: o.smoothing,
    style: o.style, contours: o.contours !== false, fontMm: o.fontMm, template: o.template?.name || null, layers: layers.length,
    minElevation: Math.round(minE), maxElevation: Math.round(maxE), demZoom: zoom,
  };
  const line = (d, colour) => `<path d="${d}" fill="none" stroke="${colour}" stroke-width="0.1"/>`;
  const fill = (rings, colour) => (rings.length ? `<path d="${polygonsToPath([rings])}" fill="${colour}" fill-rule="evenodd"/>\n` : "");

  // The production SVG takes a few seconds (numbering every piece), so it is
  // only built when someone downloads it.
  // Layered: each layer is a group of its separate pieces, so they can be
  // nested on sheets; each piece carries its glue guides, engraving and numbers.
  let piecesCache = null;
  const getPieces = () => (piecesCache ??= numberPieces(splitIntoPieces(layers, engrave, water), NUMBER_MM));
  const pieceContent = (p) =>
    line(polygonsToPath([p.poly]), COLOURS.cut) + "\n" +
    (o.guides && p.children.length ? line(polygonsToPath(p.children.map((c) => c.poly)), COLOURS.guide) + "\n" : "") +
    fillEach(p.engrave, COLOURS.engrave) +
    scorePath(p.lines.water, "water") +
    scorePath(p.lines.roads, "roads") +
    fill(p.numbers, COLOURS.number) +
    fill(p.visibleNumbers, COLOURS.numberVisible);
  const legend =
    `<!-- Red = cut, blue = glue guide, black = engrave, green = water score lines, teal = road score lines, ` +
    `orange = assembly numbers (hidden once glued), magenta = numbers on pieces with nothing on top, ` +
    `grey = sheet edges (don't cut). Top left: the assembled model for reference. To the right: the same pieces ` +
    `laid flat on cutting sheets, one layer per sheet; cut one sheet at a time. Elevation: AWS Terrain Tiles (Mapzen). Hills: Database of British and Irish Hills v18.6, CC BY 4.0. -->\n`;
  const svgOpen = (w, h, metaObj) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">\n` +
    `<metadata>${esc(JSON.stringify(metaObj))}</metadata>\n` +
    legend;

  /**
   * The production SVG: the assembled model at the top left and, for layered
   * maps, the same pieces laid flat on cutting sheets to its right (two per
   * row), each sheet its own layer.
   * @param {{w:number, h:number, marginMm:number, gapMm:number}} [sheet]
   * @returns {{text: string, sheets: number, oversize: number}}
   */
  /**
   * Material cost: lay the pieces out on each sheet size on offer and count
   * the sheets. Single engraved boards are one piece (the board).
   * @param {Array<{code:string, w:number, h:number, price:number}>} stock  sheets for one material and thickness
   * @param {{marginMm:number, gapMm:number}} spacing
   */
  const buildCost = (stock, spacing) => {
    const pieces =
      o.style === "engraved"
        ? boardPolys.map((poly, i) => ({ id: `board${i}`, poly, area: ringArea(poly[0]) }))
        : getPieces().flat();
    const areaMm2 = pieces.reduce((n, p) => n + p.area, 0);
    const options = stock.map((s) => {
      const { sheets } = nestPieces(pieces, { w: s.w, h: s.h, marginMm: spacing.marginMm, gapMm: spacing.gapMm });
      const oversize = sheets.some((x) => x.oversize);
      return { ...s, sheets: sheets.length, oversize, cost: oversize ? null : sheets.length * s.price };
    });
    return { pieces: pieces.length, areaMm2, options };
  };

  const buildSvg = (sheet) => {
    const pieces = o.style === "engraved" ? null : getPieces();
    let assembled = "";
    if (o.style === "engraved") {
      assembled += `<g inkscape:groupmode="layer" inkscape:label="Board">\n${line(outline, COLOURS.cut)}\n`;
      if (contourPath) assembled += line(contourPath, COLOURS.guide) + "\n";
      assembled += engravePath(0) + "\n" + waterPath(0) + "</g>\n";
    } else {
      layers.forEach((l, i) => {
        const name = i === 0 ? `Layer 00 base (${l.elevation} m)` : `Layer ${String(i).padStart(2, "0")} (${l.elevation} m)`;
        assembled += `<g inkscape:groupmode="layer" inkscape:label="${name}" id="layer-${i}">\n`;
        for (const p of pieces[i]) assembled += `<g id="piece-${p.id}" inkscape:label="Piece ${p.id}">\n${pieceContent(p)}</g>\n`;
        assembled += "</g>\n";
      });
    }

    // Cutting sheets, laid out in a grid to the right of the model.
    const sheets = pieces && sheet ? nestPieces(pieces.flat(), sheet).sheets : [];
    const GAP = 40, COLS = 2, x0 = W + 60;
    const cellW = Math.max(0, ...sheets.map((s) => s.w)), cellH = Math.max(0, ...sheets.map((s) => s.h));
    let sheetsSvg = "";
    sheets.forEach((s, k) => {
      const sx = x0 + (k % COLS) * (cellW + GAP), sy = Math.floor(k / COLS) * (cellH + GAP);
      const title = `Sheet ${k + 1} of ${sheets.length}${s.oversize ? " (OVERSIZE)" : ""}`;
      sheetsSvg += `<g inkscape:groupmode="layer" inkscape:label="${title}" id="sheet-${k + 1}" transform="translate(${sx} ${sy})">\n`;
      sheetsSvg += `<rect width="${s.w}" height="${s.h}" fill="none" stroke="${COLOURS.sheet}" stroke-width="0.1" inkscape:label="Sheet edge (don't cut)"/>\n`;
      for (const pl of s.placements) {
        const t = `translate(${pl.tx.toFixed(2)} ${pl.ty.toFixed(2)})${pl.deg ? ` rotate(${pl.deg})` : ""}`;
        sheetsSvg += `<g id="sheet-${k + 1}-piece-${pl.piece.id}" inkscape:label="Piece ${pl.piece.id}" transform="${t}">\n${pieceContent(pl.piece)}</g>\n`;
      }
      sheetsSvg += "</g>\n";
    });
    const rows = Math.ceil(sheets.length / COLS);
    const totalW = sheets.length ? x0 + Math.min(COLS, sheets.length) * cellW + (Math.min(COLS, sheets.length) - 1) * GAP : W;
    const totalH = Math.max(H, rows * cellH + Math.max(0, rows - 1) * GAP);

    const byLayer = (a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b);
    const fileMeta = {
      ...meta,
      pieces: pieces?.flat().length,
      // Pieces too small to carry their number; match these by shape.
      unnumberedPieces: pieces?.flat().filter((p) => p.noOwnLabel).map((p) => p.id),
      sheetMm: sheet && sheets.length ? [sheet.w, sheet.h] : undefined,
      sheets: sheets.map((s, k) => ({ sheet: k + 1, oversize: s.oversize || undefined, pieces: s.placements.map((pl) => pl.piece.id).sort(byLayer) })),
    };
    const text =
      svgOpen(totalW, totalH, fileMeta) +
      `<g inkscape:groupmode="layer" inkscape:label="Assembled model (reference)" id="assembled">\n${assembled}</g>\n` +
      sheetsSvg +
      "</svg>\n";
    return { text, sheets: sheets.length, oversize: sheets.filter((s) => s.oversize).length };
  };

  // Preview: stacked layers filled light-to-dark like real plywood.
  const tone = (i) => {
    const t = layers.length > 1 ? i / (layers.length - 1) : 0;
    const mix = (a, b) => Math.round(a + (b - a) * t);
    return `rgb(${mix(238, 150)},${mix(214, 100)},${mix(170, 55)})`;
  };
  let preview =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
    `<path d="${outline}" fill="${tone(0)}" fill-rule="evenodd"/>`;
  if (o.style === "engraved") {
    // One board: contour lines only, as they'll be engraved.
    preview += `<path d="${contourPath}" fill="none" stroke="rgba(60,30,10,.7)" stroke-width="${Math.max(W, H) / 900}"/>`;
  } else {
    layers.slice(1).forEach((l, i) => {
      preview += `<path d="${l.d}" fill="${tone(i + 1)}" fill-rule="evenodd" stroke="rgba(60,30,10,.55)" stroke-width="${Math.max(W, H) / 900}"/>`;
    });
  }
  for (const w of water) {
    const road = w.group === "roads";
    const dash = w.kind === "paths" ? ` stroke-dasharray="1.2 0.9"` : w.kind === "tracks" ? ` stroke-dasharray="2.4 1"` : "";
    preview += `<path d="${linesToPath(w.lines)}" fill="none" stroke="${road ? "#2a1d14" : "#1f3f5c"}" stroke-width="${w.widthMm}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
  }
  preview += fillEach(allMarks, COLOURS.engrave) + "</svg>";

  return { townsPlaced, buildSvg, buildCost, contourPath, labelsLeftOff, preview, meta, layers, engrave, water, places, routeOnBoard, peaksPlaced };
}
