// Rivers, lakes and coastline from OpenStreetMap (via the Overpass API), as
// lines of [lng, lat] grouped by kind. Fetched for the area being designed.

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

export const WATER_KINDS = [
  { id: "lakes", label: "Lakes, tarns & reservoirs", on: true, widthMm: 0.5 },
  { id: "rivers", label: "Rivers & canals", on: true, widthMm: 0.9 },
  { id: "streams", label: "Streams & becks", on: false, widthMm: 0.4 },
  { id: "coast", label: "Coastline", on: true, widthMm: 0.7 },
];

const QUERIES = {
  lakes: (b) => `way["natural"="water"]["water"!~"^(river|stream|canal|ditch|drain)$"](${b});relation["natural"="water"]["water"!~"^(river|stream|canal)$"](${b});way["landuse"="reservoir"](${b});`,
  rivers: (b) => `way["waterway"~"^(river|canal)$"](${b});way["natural"="water"]["water"~"^(river|canal)$"](${b});relation["natural"="water"]["water"~"^(river|canal)$"](${b});`,
  streams: (b) => `way["waterway"="stream"](${b});`,
  coast: (b) => `way["natural"="coastline"](${b});`,
};

function classify(tags = {}) {
  if (tags.natural === "coastline") return "coast";
  if (tags.waterway === "stream") return "streams";
  if (tags.waterway === "river" || tags.waterway === "canal") return "rivers";
  if (tags.natural === "water" && /^(river|canal)$/.test(tags.water || "")) return "rivers";
  if (tags.natural === "water" || tags.landuse === "reservoir") return "lakes";
  return null;
}

const toLine = (geom) => (geom || []).filter(Boolean).map((p) => [p.lon, p.lat]);

/** Turn an Overpass JSON reply into { lakes, rivers, streams, coast } line lists. */
export function parseOverpass(json) {
  const out = { lakes: [], rivers: [], streams: [], coast: [] };
  for (const el of json.elements || []) {
    const kind = classify(el.tags);
    if (!kind) continue;
    if (el.type === "way") out[kind].push(toLine(el.geometry));
    else if (el.type === "relation") for (const m of el.members || []) if (m.type === "way") out[kind].push(toLine(m.geometry));
  }
  for (const k of Object.keys(out)) out[k] = out[k].filter((l) => l.length > 1);
  return out;
}

let last = null; // { key, bounds, kinds, data }

const contains = (a, b) => a.west <= b.west && a.east >= b.east && a.south <= b.south && a.north >= b.north;

/**
 * Water lines for the given bounds and kinds (ids from WATER_KINDS). Reuses
 * the last answer when it already covers the area.
 */
export async function fetchWater(bounds, kinds) {
  if (!kinds.length) return { lakes: [], rivers: [], streams: [], coast: [] };
  if (last && contains(last.bounds, bounds) && kinds.every((k) => last.kinds.includes(k))) return last.data;
  const padX = (bounds.east - bounds.west) * 0.03, padY = (bounds.north - bounds.south) * 0.03;
  const b = { west: bounds.west - padX, east: bounds.east + padX, south: bounds.south - padY, north: bounds.north + padY };
  const bbox = [b.south, b.west, b.north, b.east].map((v) => v.toFixed(5)).join(",");
  const query = `[out:json][timeout:25];(${kinds.map((k) => QUERIES[k](bbox)).join("")});out geom;`;
  let error;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: query }) });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const data = parseOverpass(await res.json());
      last = { bounds: b, kinds: [...kinds], data };
      return data;
    } catch (err) {
      error = err;
    }
  }
  throw error;
}
