// Packs layer pieces onto cutting sheets ("nesting").
//
// Each piece is rasterised at 1 mm per pixel, grown by half the gap, and kept
// as runs of filled pixels per row. Pieces go biggest first, each at the
// top-most, then left-most spot where it fits, trying four rotations. Holes
// inside big pieces stay free, so small pieces can nest inside them.

const PX = 1; // mm per raster pixel

// Rotation used in the SVG transform rotate(deg): clockwise on screen (y down).
const rotate = (deg) => {
  const r = (deg * Math.PI) / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  return ([x, y]) => [x * c - y * s, x * s + y * c];
};

/** Rows of filled runs for a polygon rotated by deg and grown by `grow` mm. */
function rasterize(poly, deg, grow) {
  const R = rotate(deg);
  const rings = poly.map((ring) => ring.map(R));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of rings[0]) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const pad = grow + 1;
  const offX = x0 - pad, offY = y0 - pad;
  const w = Math.ceil((x1 - x0 + pad * 2) / PX), h = Math.ceil((y1 - y0 + pad * 2) / PX);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.scale(1 / PX, 1 / PX);
  g.translate(-offX, -offY);
  const path = new Path2D(rings.map((r) => "M" + r.map(([x, y]) => `${x} ${y}`).join("L") + "Z").join(""));
  g.fill(path, "evenodd");
  g.lineWidth = grow * 2;
  g.lineJoin = "round";
  g.stroke(path);
  const px = g.getImageData(0, 0, w, h).data;
  const rows = [];
  let filled = 0;
  for (let y = 0; y < h; y++) {
    const runs = [];
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && px[(y * w + x) * 4 + 3] > 0;
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        runs.push([start, x]);
        filled += x - start;
        start = -1;
      }
    }
    rows.push(runs);
  }
  return { w, h, rows, offX, offY, filled };
}

class Sheet {
  constructor(w, h, margin) {
    this.w = Math.floor(w / PX);
    this.h = Math.floor(h / PX);
    this.m = Math.ceil(margin / PX);
    this.rows = Array.from({ length: this.h }, () => []); // sorted, merged [x0, x1)
    this.placements = [];
    this.free = (this.w - this.m * 2) * (this.h - this.m * 2); // pixels left, for a quick skip
  }

  // 0 if the raster fits at (x, y); otherwise the x to try next on this row.
  blocked(r, x, y) {
    let next = 0;
    for (let i = 0; i < r.h; i++) {
      const occ = this.rows[y + i];
      if (!occ.length) continue;
      for (const [a, b] of r.rows[i]) {
        const s = x + a, e = x + b;
        for (const [oa, ob] of occ) {
          if (oa >= e) break;
          if (ob > s) next = Math.max(next, ob - a);
        }
      }
    }
    return next;
  }

  // Top-most, then left-most, spot for the raster, or null.
  find(r) {
    const xMax = this.w - this.m - r.w, yMax = this.h - this.m - r.h;
    for (let y = this.m; y <= yMax; y++) {
      for (let x = this.m; x <= xMax; ) {
        const next = this.blocked(r, x, y);
        if (!next) return [x, y];
        x = Math.max(x + 1, next);
      }
    }
    return null;
  }

  add(r, x, y) {
    this.free -= r.filled;
    for (let i = 0; i < r.h; i++) {
      if (!r.rows[i].length) continue;
      const merged = [...this.rows[y + i], ...r.rows[i].map(([a, b]) => [x + a, x + b])].sort((p, q) => p[0] - q[0]);
      const out = [];
      for (const iv of merged) {
        const last = out[out.length - 1];
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else out.push([...iv]);
      }
      this.rows[y + i] = out;
    }
  }
}

/**
 * @param {Array<{id:string, poly:number[][][], area:number}>} pieces
 * @param {{w:number, h:number, marginMm:number, gapMm:number}} sheet
 * @returns {{ sheets: Array<{w:number, h:number, oversize?:boolean, placements: Array<{piece, deg:number, tx:number, ty:number}>}> }}
 *   tx/ty with deg give the SVG transform "translate(tx ty) rotate(deg)".
 */
export function nestPieces(pieces, sheet) {
  // Antialiased edge pixels already count as filled, which adds up to a pixel,
  // so half the gap on each piece gives a real gap of about gap to gap + 1 mm.
  const grow = sheet.gapMm / 2 + 0.1;
  const sheets = [];
  const order = [...pieces].sort((a, b) => b.area - a.area);
  for (const piece of order) {
    const rasters = [0, 90, 180, 270].map((deg) => ({ deg, r: rasterize(piece.poly, deg, grow) }));
    let placed = false;
    for (const s of sheets) {
      if (s.oversize || s.free < rasters[0].r.filled) continue;
      let best = null;
      for (const { deg, r } of rasters) {
        const at = s.find(r);
        if (at && (!best || at[1] < best.at[1] || (at[1] === best.at[1] && at[0] < best.at[0]))) best = { deg, r, at };
      }
      if (best) {
        s.add(best.r, ...best.at);
        s.placements.push(place(piece, best));
        placed = true;
        break;
      }
    }
    if (placed) continue;
    const s = new Sheet(sheet.w, sheet.h, sheet.marginMm);
    let best = null;
    for (const { deg, r } of rasters) {
      const at = s.find(r);
      if (at && (!best || at[1] < best.at[1] || (at[1] === best.at[1] && at[0] < best.at[0]))) best = { deg, r, at };
    }
    if (best) {
      s.add(best.r, ...best.at);
      s.placements.push(place(piece, best));
      sheets.push(s);
    } else {
      // Bigger than a sheet: give it a sheet of its own size and flag it.
      const r = rasters[0].r;
      const big = { w: r.w * PX + sheet.marginMm * 2, h: r.h * PX + sheet.marginMm * 2, oversize: true, placements: [] };
      big.placements.push(place(piece, { deg: 0, r, at: [Math.ceil(sheet.marginMm / PX), Math.ceil(sheet.marginMm / PX)] }));
      sheets.push(big);
    }
  }
  return {
    sheets: sheets.map((s) => ({ w: s.oversize ? s.w : s.w * PX, h: s.oversize ? s.h : s.h * PX, oversize: !!s.oversize, placements: s.placements })),
  };
}

function place(piece, { deg, r, at }) {
  // Raster origin (offX, offY in rotated coords) lands at the chosen spot.
  return { piece, deg, tx: at[0] * PX - r.offX, ty: at[1] * PX - r.offY };
}
