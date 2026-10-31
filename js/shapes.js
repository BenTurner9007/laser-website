// Marker shapes for customers' special places, as outlines in a 1 x 1 box
// (y down). `rings` are closed point lists, holes included (even-odd);
// `anchor` is the point of the box that sits on the chosen spot.

const circle = (cx, cy, r, n = 48, from = 0, to = Math.PI * 2) => {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
};

function heart() {
  // Classic parametric heart, scaled into the box.
  const pts = [];
  for (let i = 0; i < 72; i++) {
    const t = (i / 72) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([0.5 + x / 34, 0.42 - y / 34]);
  }
  return [pts];
}

function star(points = 5, inner = 0.42) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner * 0.5 : 0.5;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    pts.push([0.5 + r * Math.cos(a), 0.53 + r * Math.sin(a)]);
  }
  return [pts];
}

function pin() {
  // Round head tangent to two lines meeting at the tip, with a hole.
  const cx = 0.5, cy = 0.37, r = 0.34, tip = [0.5, 1];
  const off = Math.acos(r / (tip[1] - cy));
  const outer = circle(cx, cy, r, 40, Math.PI / 2 + off, Math.PI / 2 - off + Math.PI * 2);
  outer.push(tip);
  return [outer, circle(cx, cy, 0.13, 24).reverse()];
}

export const SHAPES = {
  heart: { label: "Heart", rings: heart(), anchor: [0.5, 0.5] },
  star: { label: "Star", rings: star(), anchor: [0.5, 0.53] },
  pin: { label: "Pin", rings: pin(), anchor: [0.5, 1] },
  circle: { label: "Circle", rings: [circle(0.5, 0.5, 0.48)], anchor: [0.5, 0.5] },
  house: { label: "House", rings: [[[0.5, 0.04], [1, 0.5], [0.85, 0.5], [0.85, 0.96], [0.15, 0.96], [0.15, 0.5], [0, 0.5]]], anchor: [0.5, 0.96] },
  cross: {
    label: "Cross",
    rings: [[[0.16, 0.04], [0.5, 0.38], [0.84, 0.04], [0.96, 0.16], [0.62, 0.5], [0.96, 0.84], [0.84, 0.96], [0.5, 0.62], [0.16, 0.96], [0.04, 0.84], [0.38, 0.5], [0.04, 0.16]]],
    anchor: [0.5, 0.5],
  },
  diamond: { label: "Diamond", rings: [[[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]], anchor: [0.5, 0.5] },
  triangle: { label: "Triangle", rings: [[[0.5, 0.05], [1, 0.92], [0, 0.92]]], anchor: [0.5, 0.6] },
};

export const DEFAULT_SHAPE = "heart";

// Marker sizes offered to customers, in millimetres.
export const PLACE_SIZES = [
  { mm: 5, label: "Small" },
  { mm: 8, label: "Medium" },
  { mm: 12, label: "Large" },
];

const ringsToPath = (rings) => rings.map((r) => "M" + r.map(([x, y]) => `${+x.toFixed(4)} ${+y.toFixed(4)}`).join("L") + "Z").join("");

/** Inline SVG icon for buttons and map markers. */
export function shapeIcon(id, size = 20, attrs = 'fill="currentColor"') {
  const s = SHAPES[id] || SHAPES[DEFAULT_SHAPE];
  return `<svg viewBox="-0.05 -0.05 1.1 1.1" width="${size}" height="${size}" aria-hidden="true"><path d="${ringsToPath(s.rings)}" fill-rule="evenodd" ${attrs}/></svg>`;
}

/** A shape's rings placed so its anchor sits at (x, y), sizeMm across. */
export function placeShape(id, x, y, sizeMm) {
  const s = SHAPES[id] || SHAPES[DEFAULT_SHAPE];
  const ox = x - s.anchor[0] * sizeMm, oy = y - s.anchor[1] * sizeMm;
  return s.rings.map((r) => r.map(([u, v]) => [ox + u * sizeMm, oy + v * sizeMm]));
}
