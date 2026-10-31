// Splits each contour layer into its separate pieces, works out which pieces
// sit on which, and finds hidden spots for assembly numbers.
//
// Piece ids are the layer number plus a letter: "5B" is the second piece on
// layer 5. Each piece is engraved with its own id ("#5B") and, inside the
// glue outline of every piece that sits on it, that piece's id ("6A"). Both
// go under a piece above, so they are hidden once the model is glued.

import { textRings } from "./text.js";

const letters = (k) => (k < 26 ? String.fromCharCode(65 + k) : letters(Math.floor(k / 26) - 1) + letters(k % 26));

function bboxOf(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

const inBox = (b, [x, y]) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

// Even-odd test across a polygon's rings (outer and holes).
function inside(poly, [x, y]) {
  let c = false;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

const area = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
};

/** The piece on a layer that contains a point (or null). */
function pieceAt(pieces, pt) {
  return pieces.find((p) => inBox(p.bbox, pt) && inside(p.poly, pt)) || null;
}

/**
 * @param {Array<{polys:number[][][][]}>} layers  layer 0 = base board
 * @param {Array<{layer:number, polys:number[][][][]}>} engrave
 * @param {Array<{layer:number, lines:number[][][]}>} water
 */
export function splitIntoPieces(layers, engrave = [], water = []) {
  const byLayer = layers.map((l, i) =>
    l.polys.map((poly, k) => ({
      layer: i,
      id: `${i}${letters(k)}`,
      poly,
      bbox: bboxOf(poly[0]),
      area: area(poly[0]),
      children: [],
      engrave: [],
      water: [],
      numbers: [], // hidden: own id and ids of the pieces on top
      visibleNumbers: [], // own id when nothing sits on top
    }))
  );

  // Each piece sits on exactly one piece of the layer below.
  for (let i = 1; i < byLayer.length; i++) {
    for (const q of byLayer[i]) {
      const parent = pieceAt(byLayer[i - 1], q.poly[0][0]) || byLayer[i - 1].find((p) => inBox(p.bbox, q.poly[0][0]));
      if (parent) parent.children.push(q);
    }
  }

  // Engraving polygons and water runs are each wholly on one piece.
  for (const e of engrave) {
    for (const poly of e.polys) {
      const p = pieceAt(byLayer[e.layer] || [], poly[0][0]) || byLayer[e.layer]?.find((x) => inBox(x.bbox, poly[0][0]));
      if (p) p.engrave.push(poly);
    }
  }
  for (const w of water) {
    for (const line of w.lines) {
      const p = pieceAt(byLayer[w.layer] || [], line[Math.floor(line.length / 2)]);
      if (p) p.water.push(line);
    }
  }
  return byLayer;
}

// A piece drawn into an off-screen image once, so "is this point on the
// piece?" is a pixel lookup instead of a walk round thousands of edge points.
const MASK_PX_PER_MM = 4;
function maskOf(region) {
  if (region.mask) return region.mask;
  const k = MASK_PX_PER_MM, b = region.bbox;
  const w = Math.max(1, Math.ceil((b.x1 - b.x0) * k) + 2), h = Math.max(1, Math.ceil((b.y1 - b.y0) * k) + 2);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.setTransform(k, 0, 0, k, (1 - b.x0 * k), (1 - b.y0 * k));
  g.fill(new Path2D(region.poly.map((r) => "M" + r.map(([x, y]) => `${x} ${y}`).join("L") + "Z").join("")), "evenodd");
  const px = g.getImageData(0, 0, w, h).data;
  // Only fully covered pixels count, so edge pixels err on the safe side.
  const on = new Uint8Array(w * h);
  for (let i = 0; i < on.length; i++) on[i] = px[i * 4 + 3] === 255 ? 1 : 0;
  region.mask = ([x, y]) => {
    const ix = Math.floor((x - b.x0) * k + 1), iy = Math.floor((y - b.y0) * k + 1);
    return ix >= 0 && iy >= 0 && ix < w && iy < h && on[iy * w + ix] === 1;
  };
  return region.mask;
}

const overlaps = (a, b, gap) => a.x0 - gap < b.x1 && b.x0 - gap < a.x1 && a.y0 - gap < b.y1 && b.y0 - gap < a.y1;

/**
 * Best centre for a w x h box inside poly, at least `gap` from `taken`
 * boxes and `margin` from the edge. Prefers the middle of the space that fits.
 */
function findSpot(region, w, h, taken, margin = 0.8, gap = margin) {
  const bbox = region.bbox, isIn = maskOf(region);
  const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
  const fw = w + margin * 2, fh = h + margin * 2;
  if (bw < fw || bh < fh) return null;
  const step = Math.max(0.4, Math.sqrt((bw * bh) / 500));
  const fits = [];
  for (let cy = bbox.y0 + fh / 2; cy <= bbox.y1 - fh / 2; cy += step) {
    for (let cx = bbox.x0 + fw / 2; cx <= bbox.x1 - fw / 2; cx += step) {
      const box = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
      if (taken.some((t) => overlaps(box, t, gap))) continue;
      let ok = true;
      // 5 x 3 sample points over the box plus margin.
      for (let iy = 0; iy < 3 && ok; iy++) {
        for (let ix = 0; ix < 5 && ok; ix++) {
          ok = isIn([cx - fw / 2 + (fw * ix) / 4, cy - fh / 2 + (fh * iy) / 2]);
        }
      }
      if (ok) fits.push([cx, cy]);
    }
  }
  if (!fits.length) return null;
  const mx = fits.reduce((s, p) => s + p[0], 0) / fits.length, my = fits.reduce((s, p) => s + p[1], 0) / fits.length;
  return fits.reduce((best, p) => (Math.hypot(p[0] - mx, p[1] - my) < Math.hypot(best[0] - mx, best[1] - my) ? p : best));
}

// Outline a label centred on (cx, cy), optionally turned 90° to read
// upwards; returns its rings and box.
function label(text, cx, cy, size, upright) {
  const capH = size * 0.72;
  const t = textRings(text, 0, capH / 2, size, { weight: "bold", align: "left" });
  const turn = upright ? ([x, y]) => [cx + y, cy - x] : ([x, y]) => [cx + x, cy + y];
  const rings = t.rings.map((r) => r.map(([x, y]) => turn([x - t.width / 2, y])));
  const [w, h] = upright ? [capH, t.width] : [t.width, capH];
  return { rings, box: { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 } };
}

const textWidth = (text, size) => textRings(text, 0, 0, size, { weight: "bold" }).width;

/**
 * Place a label in the first of `regions` it fits: full size first, then
 * turned for long thin spaces, then smaller (down to ~1.6 mm, still legible).
 */
function placeLabel(text, regions, taken, sizeMm, gapMm = 0) {
  for (const size of [sizeMm, sizeMm * 0.75, sizeMm * 0.55, sizeMm * 0.4]) {
    const w = textWidth(text, size), h = size * 0.72;
    for (const upright of [false, true]) {
      for (const r of regions) {
        const margin = Math.min(0.8, size * 0.2);
        const spot = findSpot(r, upright ? h : w, upright ? w : h, taken, margin, Math.max(margin, gapMm));
        if (spot) {
          const l = label(text, spot[0], spot[1], size, upright);
          taken.push(l.box);
          return l.rings;
        }
      }
    }
  }
  return null;
}

/** Add assembly numbers to every piece (mutates the pieces). */
export function numberPieces(byLayer, sizeMm = 4) {
  for (const layer of byLayer) {
    for (const p of layer) {
      const taken = [];
      // Biggest children first: they have the most room.
      const kids = [...p.children].sort((a, b) => b.area - a.area);
      for (const q of kids) {
        const rings = placeLabel(q.id, [q], taken, sizeMm);
        if (rings) p.numbers.push(...rings);
        else q.noGuideLabel = true;
      }
      const own = `#${p.id}`;
      // Keep the piece's own number well apart from the guide numbers, so
      // "#8A" and "9C" never read as one label.
      const hidden = kids.length ? placeLabel(own, kids, taken, sizeMm, sizeMm * 3) : null;
      if (hidden) p.numbers.push(...hidden);
      else {
        // Nothing on top has room: put it anywhere on the piece, visibly.
        const rings = placeLabel(own, [p], taken, sizeMm);
        if (rings) p.visibleNumbers.push(...rings);
        else p.noOwnLabel = true;
      }
    }
  }
  for (const p of byLayer.flat()) delete p.mask; // free the images
  return byLayer;
}
