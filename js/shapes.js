// Marker shapes for customers' special places. Each path is drawn in a 1 x 1
// box; `anchor` is the point of the box that sits on the chosen spot.

function star(points = 5, inner = 0.42) {
  let d = "";
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner * 0.5 : 0.5;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    d += `${i ? "L" : "M"}${(0.5 + r * Math.cos(a)).toFixed(4)} ${(0.53 + r * Math.sin(a)).toFixed(4)}`;
  }
  return d + "Z";
}

export const SHAPES = {
  heart: {
    label: "Heart",
    d: "M0.5 0.95C0.1 0.66 0 0.42 0 0.28C0 0.1 0.15 0.02 0.29 0.02C0.4 0.02 0.47 0.09 0.5 0.17C0.53 0.09 0.6 0.02 0.71 0.02C0.85 0.02 1 0.1 1 0.28C1 0.42 0.9 0.66 0.5 0.95Z",
    anchor: [0.5, 0.5],
  },
  star: { label: "Star", d: star(), anchor: [0.5, 0.53] },
  pin: {
    label: "Pin",
    // Teardrop with a hole; the point of the pin marks the spot.
    d: "M0.5 1C0.5 1 0.14 0.6 0.14 0.37A0.36 0.36 0 0 1 0.86 0.37C0.86 0.6 0.5 1 0.5 1ZM0.5 0.23A0.14 0.14 0 1 0 0.5 0.51A0.14 0.14 0 1 0 0.5 0.23Z",
    anchor: [0.5, 1],
  },
  circle: { label: "Circle", d: "M0.5 0.02A0.48 0.48 0 1 1 0.5 0.98A0.48 0.48 0 1 1 0.5 0.02Z", anchor: [0.5, 0.5] },
  house: { label: "House", d: "M0.5 0.04L1 0.5H0.85V0.96H0.15V0.5H0Z", anchor: [0.5, 0.96] },
  cross: {
    label: "Cross",
    d: "M0.16 0.04L0.5 0.38L0.84 0.04L0.96 0.16L0.62 0.5L0.96 0.84L0.84 0.96L0.5 0.62L0.16 0.96L0.04 0.84L0.38 0.5L0.04 0.16Z",
    anchor: [0.5, 0.5],
  },
  diamond: { label: "Diamond", d: "M0.5 0L1 0.5L0.5 1L0 0.5Z", anchor: [0.5, 0.5] },
  triangle: { label: "Triangle", d: "M0.5 0.05L1 0.92H0Z", anchor: [0.5, 0.6] },
};

export const DEFAULT_SHAPE = "heart";

// Marker sizes offered to customers, in millimetres.
export const PLACE_SIZES = [
  { mm: 5, label: "Small" },
  { mm: 8, label: "Medium" },
  { mm: 12, label: "Large" },
];

/** Inline SVG icon for buttons and map markers. */
export function shapeIcon(id, size = 20, attrs = 'fill="currentColor"') {
  const s = SHAPES[id] || SHAPES[DEFAULT_SHAPE];
  return `<svg viewBox="-0.05 -0.05 1.1 1.1" width="${size}" height="${size}" aria-hidden="true"><path d="${s.d}" fill-rule="evenodd" ${attrs}/></svg>`;
}
