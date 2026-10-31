// Rivers, lakes and coastline from the water tiles that ship with the site
// (data/water/, built from OpenStreetMap via Overture Maps by
// scripts/build-water.py). Returned as lines of [lng, lat] grouped by kind.

import { decodeRoute } from "./route.js";

const BASE = "data/water/";

export const WATER_KINDS = [
  { id: "lakes", label: "Lakes, tarns & reservoirs", on: true, widthMm: 0.5 },
  { id: "rivers", label: "Rivers & canals", on: true, widthMm: 0.9 },
  { id: "streams", label: "Streams & becks", on: false, widthMm: 0.4 },
  { id: "coast", label: "Coastline", on: true, widthMm: 0.7 },
];

let index = null; // Promise<{ tile: degrees, keys: Set<"x_y"> }>
const tiles = new Map(); // "x_y" -> Promise<{ kind: lines }>

function loadIndex() {
  index ??= fetch(BASE + "index.json")
    .then((r) => {
      if (!r.ok) throw new Error(`water index ${r.status}`);
      return r.json();
    })
    .then((j) => ({ tile: j.tile, keys: new Set(j.tiles) }))
    .catch((err) => {
      index = null; // try again next time
      throw err;
    });
  return index;
}

function loadTile(key) {
  if (!tiles.has(key)) {
    const p = fetch(`${BASE}${key}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`water tile ${key} ${r.status}`);
        return r.json();
      })
      .then((t) => Object.fromEntries(Object.entries(t).map(([kind, s]) => [kind, decodeRoute(s)])))
      .catch((err) => {
        tiles.delete(key);
        throw err;
      });
    tiles.set(key, p);
  }
  return tiles.get(key);
}

/** Water lines inside bounds for the given kinds (ids from WATER_KINDS). */
export async function fetchWater(bounds, kinds) {
  const out = { lakes: [], rivers: [], streams: [], coast: [] };
  if (!kinds.length) return out;
  const { tile, keys } = await loadIndex();
  const wanted = [];
  for (let x = Math.floor(bounds.west / tile); x <= Math.floor(bounds.east / tile); x++) {
    for (let y = Math.floor(bounds.south / tile); y <= Math.floor(bounds.north / tile); y++) {
      if (keys.has(`${x}_${y}`)) wanted.push(loadTile(`${x}_${y}`));
    }
  }
  for (const t of await Promise.all(wanted)) {
    for (const k of kinds) if (t[k]) out[k].push(...t[k]);
  }
  return out;
}
