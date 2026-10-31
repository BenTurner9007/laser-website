// Turns a map frame into a laser-ready SVG layout.
//
// Elevation comes from the open Terrarium DEM tiles (AWS Terrain Tiles).
// Contours are traced with d3-contour as filled regions, so each contour
// level is a closed shape that can be cut from one sheet and stacked.

/* global d3, polygonClipping */

export const DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const DEM_MAXZOOM = 15;
const TILE = 256;

// Laser colour conventions (LightBurn / most laser software map colour to operation).
export const COLOURS = { cut: "#ff0000", guide: "#0000ff", engrave: "#000000" };

const MAX_GRID_PX = 1400; // longest side of the elevation grid
const MAX_TILES = 120;
const MIN_FEATURE_MM2 = 4; // drop islands/holes smaller than ~2 x 2 mm, too fragile to cut
const SIMPLIFY_MM = 0.05;

// --- Web Mercator helpers (world pixel coordinates at zoom z) ---
const worldSize = (z) => TILE * 2 ** z;
const lngToX = (lng, z) => ((lng + 180) / 360) * worldSize(z);
const latToY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(z);
};

function pickZoom(b) {
  for (let z = DEM_MAXZOOM; z >= 3; z--) {
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
export async function fetchElevationGrid(bounds, onProgress = () => {}) {
  const z = pickZoom(bounds);
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
      const url = DEM_URL.replace("{z}", z).replace("{x}", tx).replace("{y}", ty);
      const img = await loadImage(url);
      if (img) ctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE);
      else {
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
  for (let i = 0; i < values.length; i++) {
    const e = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    values[i] = Math.max(0, e); // flatten the sea / bathymetry to 0 m
  }
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

// --- Board templates (e.g. a round clock face) ---
function circleRing(cx, cy, r, segments = 360) {
  const ring = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return ring;
}

// polygon-clipping repeats each ring's first point at the end; drop it and tiny bits.
function tidy(mp) {
  const out = [];
  for (const polygon of mp) {
    const rings = [];
    for (let k = 0; k < polygon.length; k++) {
      const ring = polygon[k].slice(0, -1);
      if (ring.length < 3 || ringArea(ring) < MIN_FEATURE_MM2) {
        if (k === 0) break;
        continue;
      }
      rings.push(ring);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

const clip = (op, a, ...b) => {
  if (!a.length) return [];
  return tidy(polygonClipping[op](a, ...b.filter((p) => p.length)));
};

/** The board shape and engraving for a template, in layout millimetres. */
function templateGeometry(t, W, H) {
  const r = Math.min(W, H) / 2, cx = W / 2, cy = H / 2;
  const board = [[circleRing(cx, cy, r)]];
  if (t.holeDiameter) board[0].push(circleRing(cx, cy, t.holeDiameter / 2, 120).reverse());
  // Template coordinates are relative to its own diameter; scale to this board.
  const k = (2 * r) / t.diameter;
  const rings = t.engrave.map((ring) => ring.map(([x, y]) => [cx - r + x * k, cy - r + y * k]));
  // XOR turns the separate rings into shapes with holes (the inside of a 6 or 9).
  const engrave = tidy(polygonClipping.xor(...rings.map((ring) => [[[...ring, ring[0]]]])));
  return { board, engrave, cx, cy, r };
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
 */
export async function buildLayout(o, onProgress) {
  const grid = await fetchElevationGrid(o.bounds, onProgress);
  const { width: gw, height: gh, zoom } = grid;
  const radius = Math.round(o.smoothing * Math.max(1, gw / 350));
  const values = smooth(grid.values, gw, gh, radius);

  let minE = Infinity, maxE = -Infinity;
  for (const v of values) { if (v < minE) minE = v; if (v > maxE) maxE = v; }

  const levels = [];
  for (let t = Math.floor(minE / o.interval + 1) * o.interval; t <= maxE; t += o.interval) levels.push(t);

  const W = o.widthMm, H = o.heightMm, sx = W / gw, sy = H / gh;
  const contours = d3.contours().size([gw, gh]).smooth(true).thresholds(levels)(values);
  const tpl = o.template ? templateGeometry(o.template, W, H) : null;
  const boardPolys = tpl ? tpl.board : [[[[0, 0], [W, 0], [W, H], [0, H]]]];
  const outline = polygonsToPath(boardPolys);
  // Layer 0 is the base board; layer i>0 is the area at or above levels[i-1].
  const layers = [{ elevation: Math.round(minE), d: outline, polys: boardPolys }].concat(
    contours.map((c) => {
      let polys = cleanPolygons(c, sx, sy);
      if (tpl) polys = clip("intersection", polys, tpl.board);
      return { elevation: c.value, d: polygonsToPath(polys), polys };
    })
  );
  while (layers.length > 1 && !layers[layers.length - 1].polys.length) layers.pop();

  // Template engraving goes on whichever layer is on top at that spot.
  const engrave = [];
  if (tpl) {
    if (o.style === "engraved") engrave.push({ layer: 0, polys: tpl.engrave });
    else {
      layers.forEach((l, i) => {
        const onLayer = clip("intersection", tpl.engrave, l.polys);
        const visible = layers[i + 1] ? clip("difference", onLayer, layers[i + 1].polys) : onLayer;
        if (visible.length) engrave.push({ layer: i, polys: visible });
      });
    }
  }
  const engravePath = (i) =>
    engrave.filter((e) => e.layer === i).map((e) => `<path d="${polygonsToPath(e.polys)}" fill="${COLOURS.engrave}" fill-rule="evenodd"/>`).join("\n");

  // Place peaks that fall inside the frame on the layer they stand on.
  const z = zoom;
  const fx0 = lngToX(o.bounds.west, z), fy0 = latToY(o.bounds.north, z);
  const fx1 = lngToX(o.bounds.east, z), fy1 = latToY(o.bounds.south, z);
  const placed = [];
  for (const p of o.peaks) {
    const gx = ((lngToX(p.lng, z) - fx0) / (fx1 - fx0)) * gw;
    const gy = ((latToY(p.lat, z) - fy0) / (fy1 - fy0)) * gh;
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
    if (tpl && Math.hypot(gx * sx - tpl.cx, gy * sy - tpl.cy) > tpl.r - o.fontMm) continue;
    const v = values[Math.floor(gy) * gw + Math.floor(gx)];
    let layer = 0;
    while (layer < levels.length && levels[layer] <= v) layer++;
    layer = Math.min(layer, layers.length - 1);
    placed.push({ ...p, x: gx * sx, y: gy * sy, layer });
  }

  const labelText = (p) => (o.labelMode === "name-height" ? `${p.name} ${p.h} m` : p.name);
  const label = (p) => {
    if (o.labelMode === "none") return "";
    const text = labelText(p);
    const m = o.fontMm * 0.45; // marker half-size
    const right = p.x < W * 0.72;
    const tx = right ? p.x + m * 1.8 : p.x - m * 1.8;
    return (
      `<path d="M${(p.x - m).toFixed(2)} ${(p.y + m * 0.8).toFixed(2)}L${p.x.toFixed(2)} ${(p.y - m).toFixed(2)}L${(p.x + m).toFixed(2)} ${(p.y + m * 0.8).toFixed(2)}Z" fill="${COLOURS.engrave}"/>` +
      `<text x="${tx.toFixed(2)}" y="${(p.y + o.fontMm * 0.35).toFixed(2)}" font-size="${o.fontMm}" text-anchor="${right ? "start" : "end"}" fill="${COLOURS.engrave}">${esc(text)}</text>`
    );
  };

  const meta = {
    bounds: o.bounds, widthMm: W, heightMm: H, interval: o.interval, smoothing: o.smoothing,
    style: o.style, fontMm: o.fontMm, template: o.template?.name || null, layers: layers.length, minElevation: Math.round(minE), maxElevation: Math.round(maxE), demZoom: zoom,
  };
  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">\n` +
    `<metadata>${esc(JSON.stringify(meta))}</metadata>\n` +
    `<!-- Red = cut, blue = score/guide, black = engrave. Elevation: AWS Terrain Tiles (Mapzen). ` +
    `Hills: Database of British and Irish Hills v18.6, CC BY 4.0. -->\n` +
    `<g font-family="Arial, Helvetica, sans-serif">\n`;
  const line = (d, colour) => `<path d="${d}" fill="none" stroke="${colour}" stroke-width="0.1"/>`;

  let body = "";
  if (o.style === "engraved") {
    body += `<g inkscape:groupmode="layer" inkscape:label="Board">\n${line(outline, COLOURS.cut)}\n`;
    for (const l of layers.slice(1)) body += line(l.d, COLOURS.guide) + "\n";
    body += engravePath(0) + "\n" + placed.map(label).join("\n") + "\n</g>\n";
  } else {
    layers.forEach((l, i) => {
      const name = i === 0 ? `Layer 00 base (${l.elevation} m)` : `Layer ${String(i).padStart(2, "0")} (${l.elevation} m)`;
      body += `<g inkscape:groupmode="layer" inkscape:label="${name}" id="layer-${i}">\n${line(l.d, COLOURS.cut)}\n`;
      if (o.guides && layers[i + 1]) body += line(layers[i + 1].d, COLOURS.guide) + "\n";
      body += engravePath(i) + "\n";
      body += placed.filter((p) => p.layer === i).map(label).join("\n");
      body += "\n</g>\n";
    });
  }
  const svg = head + body + "</g>\n</svg>\n";

  // Preview: stacked layers filled light-to-dark like real plywood.
  const tone = (i) => {
    const t = layers.length > 1 ? i / (layers.length - 1) : 0;
    const mix = (a, b) => Math.round(a + (b - a) * t);
    return `rgb(${mix(238, 150)},${mix(214, 100)},${mix(170, 55)})`;
  };
  let preview =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif">` +
    `<path d="${outline}" fill="${tone(0)}" fill-rule="evenodd"/>`;
  layers.slice(1).forEach((l, i) => {
    preview += `<path d="${l.d}" fill="${tone(i + 1)}" fill-rule="evenodd" stroke="rgba(60,30,10,.55)" stroke-width="${Math.max(W, H) / 900}"/>`;
  });
  if (tpl) preview += `<path d="${polygonsToPath(tpl.engrave)}" fill="${COLOURS.engrave}" fill-rule="evenodd"/>`;
  preview += placed.map(label).join("") + "</svg>";

  const labels = o.labelMode === "none" ? [] : placed.map((p) => ({ x: p.x, y: p.y, layer: p.layer, text: labelText(p) }));
  return { svg, preview, meta, layers, labels, engrave, peaksPlaced: placed.length };
}
