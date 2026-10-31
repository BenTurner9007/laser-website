// Hiking routes: reading GPX/KML/GeoJSON files, compact share-link encoding,
// and turning a route line into an engravable band (in millimetres).

/* global polygonClipping */

/** Read a route file into an array of lines, each [[lng, lat], ...]. */
export function parseRouteFile(text, filename = "") {
  const name = filename.toLowerCase();
  if (name.endsWith(".json") || name.endsWith(".geojson") || /^\s*\{/.test(text)) return fromGeoJSON(JSON.parse(text));
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Couldn’t read that file");
  if (xml.querySelector("gpx, trk, rte") || name.endsWith(".gpx")) return fromGPX(xml);
  if (xml.querySelector("kml, coordinates") || name.endsWith(".kml")) return fromKML(xml);
  throw new Error("Unsupported file");
}

function fromGPX(xml) {
  const lines = [];
  const pts = (els) => [...els].map((p) => [+p.getAttribute("lon"), +p.getAttribute("lat")]);
  for (const seg of xml.getElementsByTagName("trkseg")) lines.push(pts(seg.getElementsByTagName("trkpt")));
  for (const rte of xml.getElementsByTagName("rte")) lines.push(pts(rte.getElementsByTagName("rtept")));
  return clean(lines);
}

function fromKML(xml) {
  const lines = [];
  for (const ls of xml.getElementsByTagName("LineString")) {
    const c = ls.getElementsByTagName("coordinates")[0];
    if (c) lines.push(c.textContent.trim().split(/\s+/).map((t) => t.split(",").slice(0, 2).map(Number)));
  }
  // Google/Garmin tracks: <gx:Track> with <gx:coord>lng lat alt</gx:coord>
  for (const tr of xml.getElementsByTagNameNS("*", "Track")) {
    lines.push([...tr.getElementsByTagNameNS("*", "coord")].map((c) => c.textContent.trim().split(/\s+/).slice(0, 2).map(Number)));
  }
  return clean(lines);
}

function fromGeoJSON(gj) {
  const lines = [];
  const walk = (g) => {
    if (!g) return;
    if (g.type === "FeatureCollection") g.features.forEach((f) => walk(f.geometry));
    else if (g.type === "Feature") walk(g.geometry);
    else if (g.type === "GeometryCollection") g.geometries.forEach(walk);
    else if (g.type === "LineString") lines.push(g.coordinates.map((c) => c.slice(0, 2)));
    else if (g.type === "MultiLineString") g.coordinates.forEach((l) => lines.push(l.map((c) => c.slice(0, 2))));
  };
  walk(gj);
  return clean(lines);
}

const clean = (lines) =>
  lines.map((l) => l.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90)).filter((l) => l.length > 1);

// --- Measuring and simplifying (in degrees, scaled for latitude) ---
export function routeLengthKm(lines) {
  let m = 0;
  for (const l of lines) {
    for (let i = 1; i < l.length; i++) {
      const [x1, y1] = l[i - 1], [x2, y2] = l[i];
      const k = Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
      m += Math.hypot((x2 - x1) * k, y2 - y1) * 111195;
    }
  }
  return m / 1000;
}

// Douglas-Peucker; k scales x (cos latitude for degrees, 1 for millimetres).
function simplifyLine(pts, tol, k = Math.cos((pts[0][1] * Math.PI) / 180)) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0] * k, ay = pts[a][1], bx = pts[b][0] * k, by = pts[b][1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-18;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * k, py = pts[i][1];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// --- Share-link encoding: Google's polyline algorithm, precision 5 ---
function encodeLine(pts) {
  let out = "", plat = 0, plng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lng, lat] of pts) {
    const la = Math.round(lat * 1e5), ln = Math.round(lng * 1e5);
    out += enc(la - plat) + enc(ln - plng);
    plat = la;
    plng = ln;
  }
  return out;
}

function decodeLine(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, b;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i <= str.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lng += next();
    pts.push([lng / 1e5, lat / 1e5]);
  }
  return pts;
}

/**
 * Encode lines for a URL, simplifying until it fits in maxChars so the link
 * still works in email. Lines are separated by "," (not in the alphabet).
 */
export function encodeRoute(lines, maxChars = 1000) {
  for (let tol = 0.00002; tol < 0.01; tol *= 1.6) {
    const s = lines.map((l) => encodeLine(simplifyLine(l, tol))).join(",");
    if (s.length <= maxChars) return s;
  }
  return lines.map((l) => encodeLine([l[0], l[l.length - 1]])).join(",");
}

export const decodeRoute = (s) => (s ? s.split(",").map(decodeLine).filter((l) => l.length > 1) : []);

// --- Engraving: a band of the given width along the route (mm) ---
const joint = (x, y, r, n = 10) => {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([x + r * Math.cos((i / n) * Math.PI * 2), y + r * Math.sin((i / n) * Math.PI * 2)]);
  return [pts];
};

function segmentQuad([x1, y1], [x2, y2], r) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
  const nx = (-(y2 - y1) / len) * r, ny = ((x2 - x1) / len) * r;
  return [[[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]];
}

// Cut a polyline into dashes of the given lengths.
function dashes(pts, on, off) {
  const out = [];
  let cur = [pts[0]], drawing = true, left = on;
  for (let i = 1; i < pts.length; i++) {
    let [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    let seg = Math.hypot(x2 - x1, y2 - y1);
    while (seg > left) {
      const t = left / seg;
      const p = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
      if (drawing) out.push([...cur, p]);
      cur = [p];
      [x1, y1] = p;
      seg -= left;
      drawing = !drawing;
      left = drawing ? on : off;
    }
    if (drawing) cur.push([x2, y2]);
    left -= seg;
  }
  if (drawing && cur.length > 1) out.push(cur);
  return out;
}

/**
 * Outline route lines (already in mm) as a filled band.
 * @param {number[][][]} lines
 * @param {number} widthMm
 * @param {"solid"|"dashed"} style
 */
export function routeBand(lines, widthMm, style = "solid") {
  const r = widthMm / 2;
  const parts = [];
  for (const line of lines) {
    const pts = simplifyLine(line, Math.min(0.15, widthMm / 8), 1);
    const pieces = style === "dashed" ? dashes(pts, widthMm * 3, widthMm * 2.2) : [pts];
    for (const p of pieces) {
      for (let i = 1; i < p.length; i++) parts.push(segmentQuad(p[i - 1], p[i], r));
      for (const [x, y] of p) parts.push(joint(x, y, r));
    }
  }
  return parts.length ? polygonClipping.union(...parts) : [];
}
