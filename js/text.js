// Converts label text to filled outlines (in millimetres) using Noto Sans, so
// labels can be clipped per layer like any other engraving and the SVG needs
// no fonts.

/* global opentype */

const FONT_FILES = {
  regular: ["fonts/engrave/noto-sans-latin-400-normal.woff", "fonts/engrave/noto-sans-latin-ext-400-normal.woff"],
  bold: ["fonts/engrave/noto-sans-latin-700-normal.woff", "fonts/engrave/noto-sans-latin-ext-700-normal.woff"],
};
const fonts = {}; // weight -> [latin, latinExt] once loaded
let loading = null;

const parseFont = (url) => fetch(url).then((r) => r.arrayBuffer()).then((b) => opentype.parse(b));

/** Load both weights up front so outlining text can stay synchronous. */
export function loadFonts() {
  loading ??= Promise.all(
    Object.entries(FONT_FILES).map(async ([weight, urls]) => {
      fonts[weight] = await Promise.all(urls.map(parseFont));
    })
  );
  return loading;
}

const CURVE_STEPS = 6;

// Turn opentype path commands into closed rings of [x, y] points.
function commandsToRings(commands) {
  const rings = [];
  let ring = null, x = 0, y = 0;
  for (const c of commands) {
    if (c.type === "M") {
      if (ring?.length > 2) rings.push(ring);
      ring = [[c.x, c.y]];
    } else if (c.type === "L") ring.push([c.x, c.y]);
    else if (c.type === "Q") {
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS, u = 1 - t;
        ring.push([u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y]);
      }
    } else if (c.type === "C") {
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS, u = 1 - t;
        ring.push([
          u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        ]);
      }
    } else if (c.type === "Z") {
      if (ring?.length > 2) rings.push(ring);
      ring = null;
    }
    if (c.x !== undefined) [x, y] = [c.x, c.y];
  }
  if (ring?.length > 2) rings.push(ring);
  return rings;
}

/**
 * Outline a line of text. The baseline starts at (x, y), or ends there when
 * align is "right". Characters missing from both fonts (e.g. emoji) are skipped.
 * @returns {{rings: number[][][], width: number}}
 */
export function textRings(text, x, y, sizeMm, { weight = "regular", align = "left" } = {}) {
  if (!fonts[weight]) throw new Error("call loadFonts() first");
  const glyphs = [];
  let width = 0, prev = null;
  for (const ch of text) {
    const font = fonts[weight].find((f) => f.charToGlyphIndex(ch) > 0);
    if (!font) continue;
    const glyph = font.charToGlyph(ch);
    const scale = sizeMm / font.unitsPerEm;
    if (prev && prev.font === font) width += font.getKerningValue(prev.glyph, glyph) * scale;
    glyphs.push({ glyph, at: width });
    width += glyph.advanceWidth * scale;
    prev = { font, glyph };
  }
  const x0 = align === "right" ? x - width : x;
  const rings = glyphs.flatMap(({ glyph, at }) => commandsToRings(glyph.getPath(x0 + at, y, sizeMm).commands));
  return { rings, width };
}
