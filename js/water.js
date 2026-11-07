// Line features that ship with the site as small tiles: water (data/water/,
// built by scripts/build-water.py) and roads (data/roads/, built by
// scripts/build-roads.py), both from OpenStreetMap via Overture Maps.
// Returned as lines of [lng, lat] grouped by kind.

import { decodeRoute } from "./route.js";

export const WATER_KINDS = [
  { id: "lakes", label: "Lakes, tarns & reservoirs", on: true, widthMm: 0.5 },
  { id: "rivers", label: "Rivers & canals", on: true, widthMm: 0.9 },
  { id: "streams", label: "Streams & becks", on: false, widthMm: 0.4 },
  { id: "coast", label: "Coastline", on: true, widthMm: 0.7 },
];

export const ROAD_KINDS = [
  { id: "major", label: "Motorways & A roads", on: false, widthMm: 1.0 },
  { id: "minor", label: "B roads & minor roads", on: false, widthMm: 0.6 },
  { id: "lanes", label: "Lanes & streets", on: false, widthMm: 0.4 },
  // Dotted: a short score mark every dotMm along the line. previewDotMm is
  // how big each dot is drawn in the previews, so they read as dots on screen.
  { id: "tracks", label: "Tracks", on: false, widthMm: 0.35, dotMm: 2, previewDotMm: 1.1 },
  { id: "paths", label: "Footpaths & bridleways", on: false, widthMm: 0.3, dotMm: 2.5, previewDotMm: 0.9 },
];

/** A loader for one tile set: fetch(bounds, kinds) -> { kind: lines }. */
function tileSet(base) {
  let index = null; // Promise<{ tile: degrees, keys: Set<"x_y"> }>
  const tiles = new Map(); // "x_y" -> Promise<{ kind: lines }>
  const json = (url) =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url} ${r.status}`);
      return r.json();
    });
  const loadIndex = () =>
    (index ??= json(base + "index.json")
      .then((j) => ({ tile: j.tile, keys: new Set(j.tiles), sea: j.sea || {}, box: j.box }))
      .catch((err) => {
        index = null; // try again next time
        throw err;
      }));
  const loadTile = (key) => {
    if (!tiles.has(key)) {
      tiles.set(
        key,
        json(`${base}${key}.json`)
          .then((t) => Object.fromEntries(Object.entries(t).map(([kind, s]) => [kind, decodeRoute(s)])))
          .catch((err) => {
            tiles.delete(key);
            throw err;
          })
      );
    }
    return tiles.get(key);
  };
  const fetchKinds = async (bounds, kinds) => {
    const out = Object.fromEntries(kinds.map((k) => [k, []]));
    if (!kinds.length) return out;
    const { tile, keys } = await loadIndex();
    const wanted = [];
    for (let x = Math.floor(bounds.west / tile); x <= Math.floor(bounds.east / tile); x++) {
      for (let y = Math.floor(bounds.south / tile); y <= Math.floor(bounds.north / tile); y++) {
        if (keys.has(`${x}_${y}`)) wanted.push(loadTile(`${x}_${y}`));
      }
    }
    for (const t of await Promise.all(wanted)) for (const k of kinds) if (t[k]) out[k].push(...t[k]);
    return out;
  };
  // The sea in bounds, tile by tile (see scripts/build-water.py seafill):
  // { tile, full: [[x, y], ...] all-sea tiles, part: [{x, y, rings}, ...]
  // tiles the coast crosses (rings filled even-odd within their tile) }.
  // Other tiles inside box (west, south, east, north) are land; outside it
  // the sea is not known.
  fetchKinds.sea = async (bounds) => {
    const { tile, keys, sea, box } = await loadIndex();
    const full = [], jobs = [];
    for (let x = Math.floor(bounds.west / tile); x <= Math.floor(bounds.east / tile); x++) {
      for (let y = Math.floor(bounds.south / tile); y <= Math.floor(bounds.north / tile); y++) {
        if ((sea[y] || []).some(([a, b]) => x >= a && x <= b)) full.push([x, y]);
        else if (keys.has(`${x}_${y}`)) jobs.push(loadTile(`${x}_${y}`).then((t) => (t.seafill ? { x, y, rings: t.seafill } : null)));
      }
    }
    return { tile, box, full, part: (await Promise.all(jobs)).filter(Boolean) };
  };
  return fetchKinds;
}

/** Water lines inside bounds for the given kinds (ids from WATER_KINDS). */
export const fetchWater = tileSet("data/water/");
/** The sea inside bounds (Great Britain and Ireland), for the true coastline. */
export const fetchSea = (bounds) => fetchWater.sea(bounds);
/** Road lines inside bounds for the given kinds (ids from ROAD_KINDS). */
export const fetchRoads = tileSet("data/roads/");
