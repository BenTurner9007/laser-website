// Builds data/hills.geojson from a DoBIH extract.
//
// Usage: node scripts/build-hills.mjs [scripts/source/dobih-extract.json]
//
// The source file is the CC BY 4.0 extract of The Database of British and
// Irish Hills v18.6 (https://www.hill-bagging.co.uk/dobih) published in
// github.com/Bailsby/hill-bagger. It holds a `hills` array and a `lists`
// object mapping list names to hill ids.

import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2] || new URL("./source/dobih-extract.json", import.meta.url);
const out = new URL("../data/hills.geojson", import.meta.url);

const { source, hills, lists } = JSON.parse(readFileSync(src, "utf8"));

const membership = new Map();
for (const [list, ids] of Object.entries(lists)) {
  for (const id of ids) {
    if (!membership.has(id)) membership.set(id, []);
    membership.get(id).push(list);
  }
}

const features = hills.map((h) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [h.lng, h.lat] },
  properties: {
    id: h.id,
    name: h.name,
    h: Math.round(h.metres),
    gr: h.gridRef,
    area: h.area,
    // Comma-wrapped so a map filter can match ",wainwrights," exactly.
    lists: "," + (membership.get(h.id) || []).join(",") + ",",
  },
}));

const geojson = {
  type: "FeatureCollection",
  attribution: `${source.name} v${source.version}, ${source.licence} (${source.url})`,
  features,
};

writeFileSync(out, JSON.stringify(geojson));
const counts = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length]));
console.log(`Wrote ${features.length} hills`, counts);
