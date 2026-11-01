/* global maplibregl, mlcontour */
import { CONFIG, REGIONS, HILL_LISTS } from "./config.js";
import { buildLayout, DEM_URL, EARTH_DEM } from "./layout.js";
import { createViewer } from "./viewer3d.js";
import { SHAPES, DEFAULT_SHAPE, PLACE_SIZES, shapeIcon } from "./shapes.js";
import { parseRouteFile, encodeRoute, decodeRoute, routeLengthKm } from "./route.js";
import { WATER_KINDS, ROAD_KINDS, fetchWater, fetchRoads } from "./water.js";

const $ = (s) => document.querySelector(s);
const FONT = ["NotoSans-Regular"];
const FONT_BOLD = ["NotoSans-Bold"];
// MapLibre needs an absolute glyph URL; the fonts ship with the site.
const GLYPHS = new URL("fonts/", location.href).href + "{fontstack}/{range}.pbf";

// ---------- State (also round-tripped through the share link) ----------
const params = new URLSearchParams(location.search);
const state = {
  w: +params.get("w") || CONFIG.sizes[0].w,
  h: +params.get("h") || CONFIG.sizes[0].h,
  interval: +params.get("ci") || 50,
  smoothing: params.has("sm") ? +params.get("sm") : 1,
  style: params.get("style") === "engraved" ? "engraved" : "layered",
  labelMode: params.get("labels") || "name-height",
  fontMm: +params.get("font") || 3.5,
  // Place names to label: "none", "c" cities, "ct" + towns, "ctv" + villages.
  placeNames: ["c", "ct", "ctv"].includes(params.get("pn")) ? params.get("pn") : "none",
  placeFontMm: +params.get("pfont") || 3.5,
  labelBoxes: params.get("lbox") === "1",
  // Every bundled hill list is named (and Moon/Mars features); no per-list choice.
  lists: new Set([...HILL_LISTS.map((l) => l.id), "features"]),
  sharedBounds: params.get("b") ? params.get("b").split(",").map(Number) : null,
  thickness: +params.get("t") || CONFIG.defaultThickness || 3,
  material: params.get("mat") || "",
  // Customers' special places: { lng, lat, shape, label }.
  places: parsePlaces(params.get("poi")),
  placeMm: +params.get("psz") || PLACE_SIZES[1].mm,
  // Water features to engrave (ids from WATER_KINDS).
  water: params.has("wtr")
    ? new Set(params.get("wtr").split(",").filter((id) => WATER_KINDS.some((k) => k.id === id)))
    : new Set(WATER_KINDS.filter((k) => k.on).map((k) => k.id)),
  // Roads and paths to score (ids from ROAD_KINDS); off unless asked for.
  roads: new Set((params.get("rds") || "").split(",").filter((id) => ROAD_KINDS.some((k) => k.id === id))),
  // Hiking route: lines of [lng, lat], engraved as a band.
  route: {
    lines: safeDecodeRoute(params.get("rt")),
    style: params.get("rs") === "dashed" ? "dashed" : "solid",
    widthMm: [0.8, 1.2, 2].includes(+params.get("rw")) ? +params.get("rw") : 1.2,
  },
  // Board template id (e.g. the clock); null for plain rectangles.
  template: CONFIG.sizes.find((s) => s.id === params.get("tpl") && s.template)?.id || null,
};
const templates = {};
const sizeOf = (id) => CONFIG.sizes.find((s) => s.id === id);
async function loadTemplate(id) {
  const s = sizeOf(id);
  if (!s?.template) return null;
  templates[id] ??= await fetch(s.template).then((r) => r.json());
  return templates[id];
}
function safeDecodeRoute(text) {
  try {
    return decodeRoute(text);
  } catch {
    return [];
  }
}

function parsePlaces(text) {
  try {
    return JSON.parse(text || "[]")
      .slice(0, 3)
      .map(([lng, lat, shape, label]) => ({ lng: +lng, lat: +lat, shape: SHAPES[shape] ? shape : DEFAULT_SHAPE, label: String(label || "").slice(0, 40) }))
      .filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat));
  } catch {
    return [];
  }
}
// A shared link's exact area is used for the layout until the map is moved by hand.
let pinnedBounds = null;
let lastResult = null;

// ---------- World: Earth, or the Moon / Mars famous-places collection ----------
const BODY = ["moon", "mars"].includes(params.get("body")) ? params.get("body") : "earth";
// Plywood offered and its sheet prices (data/materials.json, built from the
// supplier's price list by scripts/build-materials.py).
const MATERIALS = await fetch("data/materials.json").then((r) => r.json());
const materialByName = (name) => MATERIALS.materials.find((m) => m.name === name) || MATERIALS.materials[0];
const planets = BODY === "earth" ? null : await fetch("data/planets/sites.json").then((r) => r.json());
const WORLDS = {
  earth: {
    label: "Earth", radius: 6371008, features: "data/hills.geojson",
    paper: "#efe2c8", shadow: "#4a3d34", highlight: "#fbf7f0", contour: "#6e6457",
    credit: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen / AWS</a>',
  },
  moon: {
    label: "Moon", the: "the Moon", radius: 1737400, features: "data/planets/moon-features.geojson",
    paper: "#e2dfd9", shadow: "#36332f", highlight: "#f8f7f4", contour: "#5f5b55",
    credit: "Moon: SLDEM2015 (NASA LRO LOLA + JAXA SELENE), USGS, public domain",
  },
  mars: {
    label: "Mars", the: "Mars", radius: 3396190, features: "data/planets/mars-features.geojson",
    paper: "#efd6bb", shadow: "#5b3524", highlight: "#fdf1e4", contour: "#7a4b35",
    credit: "Mars: MRO CTX DTMs (NASA/JPL/MSSS), USGS, CC0",
  },
};
const WORLD = WORLDS[BODY];
const SITES = planets ? planets.sites.filter((s) => s.body === BODY) : [];
const DEM =
  BODY === "earth"
    ? EARTH_DEM
    : { url: new URL(`data/planets/${BODY}/`, location.href).href + "{z}/{x}/{y}.png", maxzoom: planets.bodies[BODY].maxzoom, sea: false };
// Each site is built to its own finest zoom. The live map uses the zoom every
// site has; a layout uses the finest zoom of the site it is in (siteDem).
const MAP_DEM_MAXZOOM = BODY === "earth" ? 13 : Math.min(...SITES.map((s) => s.maxzoom));
const siteDem = (b) => {
  if (BODY === "earth") return DEM;
  const inside = SITES.filter((s) => b.east > s.box[0] && b.west < s.box[2] && b.north > s.box[1] && b.south < s.box[3]);
  return { ...DEM, maxzoom: inside.length ? Math.min(...inside.map((s) => s.maxzoom)) : MAP_DEM_MAXZOOM };
};
if (BODY !== "earth") {
  // No water, routes or UK hill search off-world.
  state.water = new Set();
  state.roads = new Set();
  state.route.lines = [];
}

// Etsy mode: design here, buy on Etsy (see CONFIG.etsy).
const ETSY = !!CONFIG.etsy?.enabled || params.get("etsy") === "1";

// ---------- Branding ----------
document.title = `${CONFIG.businessName} – Contour Map Designer`;
$("#brand-name").textContent = CONFIG.businessName;
$("#brand-tagline").textContent = CONFIG.tagline;

// ---------- Map ----------
const demSource = new mlcontour.DemSource({ url: DEM.url, encoding: "terrarium", maxzoom: MAP_DEM_MAXZOOM, worker: true });
demSource.setupMaplibre(maplibregl);

const contourTiles = (ci) =>
  demSource.contourProtocolUrl({
    thresholds: {
      7: [ci * 10, ci * 20],
      9: [ci * 4, ci * 20],
      11: [ci * 2, ci * 10],
      12: [ci, ci * 5],
    },
    elevationKey: "ele",
    levelKey: "level",
    contourLayer: "contours",
  });

const listFilter = () => ["any", ...[...state.lists].map((id) => ["in", `,${id},`, ["get", "lists"]])];

const map = new maplibregl.Map({
  container: "map",
  center: SITES.length ? [(SITES[0].box[0] + SITES[0].box[2]) / 2, (SITES[0].box[1] + SITES[0].box[3]) / 2] : [-3.1, 54.48],
  zoom: SITES.length ? SITES[0].maxzoom - 2 : 10.6,
  maxZoom: BODY === "earth" ? 22 : MAP_DEM_MAXZOOM + 3,
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: { compact: true },
  style: {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      dem: {
        type: "raster-dem",
        encoding: "terrarium",
        tiles: [demSource.sharedDemProtocolUrl],
        tileSize: 256,
        maxzoom: MAP_DEM_MAXZOOM,
        attribution: WORLD.credit,
      },
      contours: { type: "vector", tiles: [contourTiles(state.interval)], maxzoom: 15 },
      hills: {
        type: "geojson",
        data: WORLD.features,
        ...(BODY === "earth" ? { attribution: '<a href="https://www.hill-bagging.co.uk/dobih">DoBIH v18.6</a> CC BY 4.0' } : {}),
      },
      // Same data again without labels, so the dots still draw if label fonts fail to load.
      "hills-pts": { type: "geojson", data: WORLD.features },
      route: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      water: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      roads: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      towns: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      "route-draft": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      { id: "paper", type: "background", paint: { "background-color": WORLD.paper } },
      {
        id: "hillshade",
        type: "hillshade",
        source: "dem",
        paint: { "hillshade-exaggeration": BODY === "earth" ? 0.35 : 0.6, "hillshade-shadow-color": WORLD.shadow, "hillshade-highlight-color": WORLD.highlight },
      },
      {
        id: "contour-lines",
        type: "line",
        source: "contours",
        "source-layer": "contours",
        paint: { "line-color": WORLD.contour, "line-opacity": ["match", ["get", "level"], 1, 0.85, 0.45], "line-width": ["match", ["get", "level"], 1, 1.3, 0.6] },
      },
      {
        id: "contour-labels",
        type: "symbol",
        source: "contours",
        "source-layer": "contours",
        filter: [">", ["get", "level"], 0],
        layout: { "symbol-placement": "line", "text-size": 10, "text-field": ["concat", ["to-string", ["get", "ele"]], " m"], "text-font": FONT },
        paint: { "text-color": "#685e52", "text-halo-color": "#efe2c8", "text-halo-width": 1.2 },
      },
      // Roads solid; tracks and paths dashed (dashes can't vary by data, so separate layers).
      ...[
        ["road-lines", ["in", ["get", "kind"], ["literal", ["major", "minor", "lanes"]]], null],
        ["road-tracks", ["==", ["get", "kind"], "tracks"], [4, 1.5]],
        ["road-paths", ["==", ["get", "kind"], "paths"], [2, 1.5]],
      ].map(([id, filter, dash]) => ({
        id,
        type: "line",
        source: "roads",
        filter,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["match", ["get", "kind"], "major", "#8c4a2f", "minor", "#9a6b45", "paths", "#7a2e12", "tracks", "#5e4632", "#6b5a48"],
          "line-width": ["match", ["get", "kind"], "major", 2.4, "minor", 1.7, "lanes", 1.2, 1.3],
          "line-opacity": 0.85,
          ...(dash ? { "line-dasharray": dash } : {}),
        },
      })),
      {
        id: "water-lines",
        type: "line",
        source: "water",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#2f6f9f",
          "line-width": ["match", ["get", "kind"], "rivers", 2.2, "coast", 2, "lakes", 1.6, 1],
          "line-opacity": 0.9,
        },
      },
      {
        id: "route-casing",
        type: "line",
        source: "route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#fbf7f0", "line-width": 6.5 },
      },
      {
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#b9581f", "line-width": 3.5 },
      },
      {
        id: "route-draft-line",
        type: "line",
        source: "route-draft",
        paint: { "line-color": "#2e2723", "line-width": 2.5, "line-dasharray": [2, 1.5] },
      },
      {
        id: "route-draft-pts",
        type: "circle",
        source: "route-draft",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": "#2e2723", "circle-stroke-width": 2 },
      },
      {
        id: "hills-dots",
        type: "circle",
        source: "hills-pts",
        filter: listFilter(),
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2.5, 12, 5], "circle-color": "#b9581f", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
      },
      {
        id: "hills-labels",
        type: "symbol",
        source: "hills",
        filter: listFilter(),
        layout: {
          "text-field": ["format", ["get", "name"], { "font-scale": 1 }, "\n", {}, ["concat", ["to-string", ["get", "h"]], " m"], { "font-scale": 0.8 }],
          "text-font": FONT_BOLD,
          "text-size": 12,
          "text-offset": [0, 0.8],
          "text-anchor": "top",
          "symbol-sort-key": ["-", ["get", "h"]],
        },
        paint: { "text-color": "#2e2723", "text-halo-color": "#fbf7f0", "text-halo-width": 1.5 },
      },
      {
        id: "town-labels",
        type: "symbol",
        source: "towns",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["match", ["get", "kind"], "c", ["literal", FONT_BOLD], ["literal", FONT]],
          "text-size": ["match", ["get", "kind"], "c", 15, "t", 13, 11],
          "symbol-sort-key": ["match", ["get", "kind"], "c", 0, "t", 1, 2],
          "text-allow-overlap": false,
        },
        paint: { "text-color": "#3d3128", "text-halo-color": "#fbf7f0", "text-halo-width": 1.6 },
      },
    ],
  },
});
let styleReady = false;
map.once("style.load", () => (styleReady = true));
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

// Hill popups
map.on("click", "hills-dots", (e) => {
  if (drawing) return;
  const p = e.features[0].properties;
  const lists = p.lists.split(",").filter(Boolean).map((id) => HILL_LISTS.find((l) => l.id === id)?.label || id).join(", ");
  new maplibregl.Popup({ offset: 8 })
    .setLngLat(e.features[0].geometry.coordinates)
    .setHTML(`<strong>${escapeHtml(p.name)}</strong><br>${p.h} m · ${escapeHtml(p.gr)}<br><small>${escapeHtml(lists)}</small>`)
    .addTo(map);
});
map.on("mouseenter", "hills-dots", () => (map.getCanvas().style.cursor = "pointer"));
map.on("mouseleave", "hills-dots", () => (map.getCanvas().style.cursor = ""));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- Frame ----------
const frameEl = $("#frame");
function frameRect() {
  const box = $(".map-wrap").getBoundingClientRect();
  const margin = box.width < 600 ? 28 : 56;
  const scale = Math.min((box.width - margin * 2) / state.w, (box.height - margin * 2 - 30) / state.h);
  const fw = state.w * scale, fh = state.h * scale;
  return { x: (box.width - fw) / 2, y: (box.height - fh) / 2, w: fw, h: fh, cw: box.width, ch: box.height };
}

function layoutFrame() {
  const r = frameRect();
  Object.assign(frameEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  $("#frame-size").textContent = state.template ? sizeOf(state.template).label : `${state.w} × ${state.h} mm`;
  updateScale();
}

// Round frame with the template's engraving overlaid, so customers can see
// where the numbers will fall on their hills.
async function renderFrameTemplate() {
  const id = state.template;
  frameEl.classList.toggle("templated", !!id);
  $("#frame-overlay").innerHTML = "";
  if (!id) return;
  const t = await loadTemplate(id);
  if (state.template !== id) return;
  const path = (rings) => rings.map((r) => "M" + r.map(([x, y]) => `${x} ${y}`).join("L") + "Z").join("");
  // Dim everything outside the board, show holes, the map area and engraving.
  $("#frame-overlay").innerHTML =
    `<svg viewBox="0 0 ${t.w} ${t.h}" preserveAspectRatio="none">` +
    `<path class="tpl-outside" d="M0 0H${t.w}V${t.h}H0Z${path([t.outline])}" fill-rule="evenodd"/>` +
    `<path class="tpl-edge" d="${path([t.outline])}" vector-effect="non-scaling-stroke"/>` +
    (t.mapArea ? `<path class="tpl-map" d="${path([t.mapArea])}" vector-effect="non-scaling-stroke"/>` : "") +
    (t.holes?.length ? `<path class="tpl-hole" d="${path(t.holes)}" vector-effect="non-scaling-stroke"/>` : "") +
    (t.engrave?.length ? `<path class="tpl-engrave" d="${path(t.engrave)}" fill-rule="evenodd"/>` : "") +
    `</svg>`;
}

function frameBounds() {
  const r = frameRect();
  const nw = map.unproject([r.x, r.y]);
  const se = map.unproject([r.x + r.w, r.y + r.h]);
  return { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
}

function groundWidthMetres(b) {
  const lat = ((b.north + b.south) / 2) * (Math.PI / 180);
  return (b.east - b.west) * (Math.PI / 180) * WORLD.radius * Math.cos(lat);
}

function updateScale() {
  const b = frameBounds();
  const metres = groundWidthMetres(b);
  const scale = metres / (state.w / 1000);
  const km = metres / 1000;
  $("#frame-scale").textContent = `${km < 10 ? km.toFixed(1) : Math.round(km)} km across · 1:${(Math.round(scale / 100) * 100).toLocaleString("en-GB")}`;
}

// Move the map so [west, south, east, north] fills the frame.
function fitFrameTo([w, s, e, n], duration = 0) {
  const r = frameRect();
  map.fitBounds(
    [[w, s], [e, n]],
    { padding: { top: r.y, left: r.x, bottom: r.ch - r.y - r.h, right: r.cw - r.x - r.w }, duration }
  );
}

new ResizeObserver(layoutFrame).observe($(".map-wrap"));
map.on("move", updateScale);
map.on("movestart", (e) => {
  if (e.originalEvent) pinnedBounds = null;
});
// "load" waits for every tile; the style being ready is enough to position the map.
// (isStyleLoaded() is also false while tiles load, after "style.load" has
// already fired, so remember the event instead.)
const onStyleReady = (fn) => (styleReady ? fn() : map.once("style.load", fn));
onStyleReady(() => {
  layoutFrame();
  if (state.sharedBounds?.length === 4 && state.sharedBounds.every(Number.isFinite)) {
    fitFrameTo(state.sharedBounds);
    const [west, south, east, north] = state.sharedBounds;
    pinnedBounds = { west, south, east, north };
  } else if (SITES.length) {
    fitFrameTo(SITES[0].box); // Moon / Mars: start on the first famous place
  }
});

// ---------- Step 1: search and regions ----------
let hillIndex = [];
fetch(WORLD.features)
  .then((r) => r.json())
  .then((gj) => {
    hillIndex = gj.features;
    const opts = hillIndex
      .slice()
      .sort((a, b) => a.properties.name.localeCompare(b.properties.name))
      .map((f) => `<option value="${escapeHtml(f.properties.name)} (${f.properties.h} m)"></option>`);
    $("#hill-names").innerHTML = opts.join("");
  });

$("#hill-search").addEventListener("change", (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  const hit =
    hillIndex.find((f) => `${f.properties.name} (${f.properties.h} m)`.toLowerCase() === q) ||
    hillIndex.find((f) => f.properties.name.toLowerCase() === q) ||
    hillIndex.find((f) => f.properties.name.toLowerCase().includes(q));
  if (hit) map.flyTo({ center: hit.geometry.coordinates, zoom: Math.max(map.getZoom(), 12) });
  else setStatus(`No hill called “${e.target.value}” in our lists – try panning the map instead.`, "error");
});

// Contour spacing: the select, the map's contour lines and the layout.
function setInterval_(ci) {
  state.interval = ci;
  $("#interval").value = String(ci);
  onStyleReady(() => map.getSource("contours").setTiles([contourTiles(ci)]));
}
// About 15 layers over a place's height range, rounded to an offered spacing.
const intervalFor = (site) => {
  const steps = [...$("#interval").options].map((o) => +o.value);
  const want = (site.elevation[1] - site.elevation[0]) / 15;
  return steps.find((v) => v >= want) || steps[steps.length - 1];
};

// Moon / Mars: the famous places replace the hill search and regions.
if (BODY !== "earth") {
  $("#step1-title").textContent = `Choose a place on ${WORLD.the}`;
  $("#hill-search-field").hidden = true;
  $("#regions").hidden = true;
  $("#sites").hidden = false;
  $("#sites").innerHTML = SITES.map((s, i) => `<button type="button" class="chip" data-i="${i}">${escapeHtml(s.name)}</button>`).join("");
  $("#sites").addEventListener("click", (e) => {
    const s = SITES[e.target.dataset.i];
    if (!s) return;
    pinnedBounds = null;
    fitFrameTo(s.box, 800);
    setInterval_(intervalFor(s));
  });
  // Off-world relief is kilometres deep: start with a spacing that suits the place.
  if (!params.has("ci") && SITES.length) setInterval_(intervalFor(SITES[0]));
  document.querySelector(".step:has(#route-file)").hidden = true;
  $("#water-kinds").closest("fieldset").hidden = true;
  $("#road-kinds").closest("fieldset").hidden = true;
  $("#place-label-row").hidden = true;
  $(".site-footer p").innerHTML =
    `${WORLD.credit}. Heights are measured from ${WORLD.the}'s reference sphere, so many are negative. ` +
    `Data courtesy of NASA, JAXA and the USGS Astrogeology Science Center.`;
}
document.querySelectorAll(".world-switch a").forEach((a) => {
  a.setAttribute("aria-selected", a.dataset.body === BODY);
  // Keep the board size and style when hopping between worlds.
  const keep = new URLSearchParams({ ...(a.dataset.body !== "earth" ? { body: a.dataset.body } : {}), w: state.w, h: state.h, style: state.style });
  if (state.template) keep.set("tpl", state.template);
  if (params.get("etsy") === "1") keep.set("etsy", "1");
  a.href = "?" + keep;
});

$("#regions").innerHTML = REGIONS.map((r, i) => `<button type="button" class="chip" data-i="${i}">${r.label}</button>`).join("");
$("#regions").addEventListener("click", (e) => {
  const r = REGIONS[e.target.dataset.i];
  if (r) map.flyTo({ center: [r.at[0], r.at[1]], zoom: r.at[2] });
});

// ---------- Step 2: sizes ----------
function renderSizes() {
  $("#sizes").innerHTML = CONFIG.sizes
    .map((s) => {
      const on = state.template ? s.id === state.template : !s.template && s.w === state.w && s.h === state.h;
      return `<button type="button" class="chip" role="radio" aria-checked="${on}" data-id="${s.id}">${s.label}</button>`;
    })
    .join("");
  $("#size-w").value = state.w;
  $("#size-h").value = state.h;
}
$("#sizes").addEventListener("click", (e) => {
  const s = CONFIG.sizes.find((x) => x.id === e.target.dataset.id);
  if (!s) return;
  setSize(s.w, s.h, s.template ? s.id : null);
});
for (const id of ["#size-w", "#size-h"]) {
  $(id).addEventListener("change", () => {
    const w = clamp(+$("#size-w").value || state.w, 50, 1000);
    const h = clamp(+$("#size-h").value || state.h, 50, 1000);
    setSize(w, h);
  });
}
// A shared link's area is only reused if its shape matches the board.
function pinnedMatchesFrame() {
  if (!pinnedBounds) return false;
  const b = pinnedBounds;
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const aspect = (((b.east - b.west) * Math.PI) / 180) / (merc(b.north) - merc(b.south));
  return Math.abs(aspect / (state.w / state.h) - 1) < 0.02;
}

function setSize(w, h, template = null) {
  pinnedBounds = null; // a shared link's area no longer matches the new frame
  state.w = w;
  state.h = h;
  state.template = template;
  renderSizes();
  layoutFrame();
  renderFrameTemplate();
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- Step 3: style ----------
document.querySelectorAll('input[name="style"]').forEach((el) => {
  el.checked = el.value === state.style;
  el.addEventListener("change", () => (state.style = el.value));
});
$("#interval").value = String(state.interval);
$("#interval").addEventListener("change", (e) => setInterval_(+e.target.value));
$("#smoothing").value = String(state.smoothing);
$("#smoothing").addEventListener("change", (e) => (state.smoothing = +e.target.value));
$("#label-mode").value = state.labelMode;
$("#label-mode").addEventListener("change", (e) => (state.labelMode = e.target.value));
$("#font-mm").value = String(state.fontMm);
$("#font-mm").addEventListener("change", (e) => (state.fontMm = +e.target.value));
$("#place-names").value = state.placeNames;
$("#place-names").addEventListener("change", (e) => {
  state.placeNames = e.target.value;
  showPlaceNames();
});
$("#place-font-mm").value = String(state.placeFontMm);
$("#place-font-mm").addEventListener("change", (e) => (state.placeFontMm = +e.target.value));
$("#label-boxes").checked = state.labelBoxes;
$("#label-boxes").addEventListener("change", (e) => (state.labelBoxes = e.target.checked));


// ---------- Step 4: generate ----------
function setStatus(msg, kind = "") {
  const el = $("#status");
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function peaksInFrame(b) {
  const inside = ([lng, lat]) => lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;
  return hillIndex
    .filter((f) => inside(f.geometry.coordinates) && [...state.lists].some((id) => f.properties.lists.includes(`,${id},`)))
    .map((f) => ({ name: f.properties.name, h: f.properties.h, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
}

function shareLink(b, ref) {
  const p = new URLSearchParams({
    ref,
    ...(BODY !== "earth" ? { body: BODY } : {}),
    b: [b.west, b.south, b.east, b.north].map((v) => v.toFixed(5)).join(","),
    ...(state.template ? { tpl: state.template } : {}),
    w: state.w,
    h: state.h,
    ci: state.interval,
    sm: state.smoothing,
    style: state.style,
    labels: state.labelMode,
    ...(state.places.length
      ? { poi: JSON.stringify(state.places.map((p) => [+p.lng.toFixed(5), +p.lat.toFixed(5), p.shape, p.label])), psz: state.placeMm }
      : {}),
    ...(state.route.lines.length ? { rt: encodeRoute(state.route.lines), rs: state.route.style, rw: state.route.widthMm } : {}),
    wtr: [...state.water].join(","),
    ...(state.roads.size ? { rds: [...state.roads].join(",") } : {}),
    font: state.fontMm,
    ...(state.placeNames !== "none" ? { pn: state.placeNames, pfont: state.placeFontMm } : {}),
    ...(state.labelBoxes ? { lbox: "1" } : {}),
    t: $("#thickness").value,
    mat: $("#material").value,
  });
  return `${location.origin}${location.pathname}?${p}`;
}

$("#generate").addEventListener("click", async () => {
  const btn = $("#generate");
  btn.disabled = true;
  const fromLink = pinnedMatchesFrame();
  const b = fromLink ? pinnedBounds : frameBounds();
  try {
    setStatus("Fetching elevation data…");
    // Water tiles ship with the site; if one fails to load, carry on without water.
    let water = null, roads = null, waterFailed = false;
    try {
      [water, roads] = await Promise.all([waterFor(b), roadsFor(b)]);
    } catch {
      waterFailed = true;
    }
    const result = await buildLayout(
      {
        bounds: b,
        widthMm: state.w,
        heightMm: state.h,
        interval: state.interval,
        smoothing: state.smoothing,
        style: state.style,
        peaks: peaksInFrame(b),
        labelMode: state.labelMode,
        fontMm: state.fontMm,
        towns: state.placeNames === "none" ? [] : placesInFrame(b),
        townFontMm: state.placeFontMm,
        labelBoxes: state.labelBoxes,
        dem: siteDem(b),
        template: state.template ? await loadTemplate(state.template) : null,
        places: state.places,
        placeMm: state.placeMm,
        route: state.route.lines.length ? state.route : null,
        water,
        roads,
        guides: true,
      },
      (f) => setStatus(`Fetching elevation data… ${Math.round(f * 100)}%`)
    );
    // Rebuilding a customer's link keeps their reference, so files match emails.
    const ref = (fromLink && sharedRef) || makeRef();
    lastResult = { ...result, bounds: b, link: shareLink(b, ref), ref, waterFailed };
    showResult();
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong building the layout. Please try again.", "error");
  } finally {
    btn.disabled = false;
  }
});

// The famous place (Moon / Mars) the layout's centre falls in, if any.
const siteName = (b) => {
  const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
  return SITES.find((s) => cx >= s.box[0] && cx <= s.box[2] && cy >= s.box[1] && cy <= s.box[3])?.name || "";
};

// "Clock 305 mm (Ø305 mm)" for templates, "210 × 297 mm" otherwise.
const sizeText = (m) =>
  m.template ? `${m.template} (${Math.round(m.widthMm)} × ${Math.round(m.heightMm)} mm)` : `${m.widthMm} × ${m.heightMm} mm`;

const makeRef = () => "CM-" + Date.now().toString(36).toUpperCase().slice(-6);
const sharedRef = /^CM-[A-Z0-9]{1,8}$/.test(params.get("ref") || "") ? params.get("ref") : null;

function stackHeight() {
  return lastResult ? lastResult.meta.layers * +$("#thickness").value : 0;
}

function renderStats() {
  const m = lastResult.meta;
  const items = [
    ["Reference", lastResult.ref],
    ["Size", sizeText(m)],
    ["Heights", `${m.minElevation}–${m.maxElevation} m`],
    [m.style === "layered" ? "Layers" : "Contour lines", m.style === "layered" ? m.layers : m.layers - 1],
    ["Named peaks", lastResult.peaksPlaced],
    ...(state.placeNames !== "none" && BODY === "earth" ? [["Place names", lastResult.townsPlaced]] : []),
    ...(lastResult.labelsLeftOff
      ? [["Names left off", `${lastResult.labelsLeftOff} (no room without overlapping – try smaller text or zoom in)`]]
      : []),
    ...(state.places.length ? [["Special places", lastResult.places.length]] : []),
    ...(state.route.lines.length ? [["Route", `${routeLengthKm(state.route.lines).toFixed(1)} km`]] : []),
    ...(state.water.size && !lastResult.waterFailed ? [["Water", waterLabel()]] : []),
    ...(state.roads.size && !lastResult.waterFailed ? [["Roads", roadLabel()]] : []),
  ];
  if (m.style === "layered") items.push(["Stack height", `≈ ${stackHeight()} mm`]);
  let html = items.map(([k, v]) => `<li>${k}: <b>${escapeHtml(v)}</b></li>`).join("");
  if (lastResult.waterFailed) {
    html += `<li class="status error">Couldn’t load rivers, lakes or roads just now, so this layout has none. Close this and try again.</li>`;
  }
  if (state.route.lines.length && !lastResult.routeOnBoard) {
    html += `<li class="status error">Your route is ${m.template ? "off the board’s map area (or over a hole)" : "outside the frame"}, so not included. Close this and use “Fit frame to route”.</li>`;
  }
  const missing = state.places.length - lastResult.places.length;
  if (missing > 0) {
    html += `<li class="status error">${missing === 1 ? "One special place is" : `${missing} special places are`} ${m.template ? "off the board’s map area (or over a hole)" : "outside the frame"}, so not included. Close this, drag it inside the frame and create the layout again.</li>`;
  }
  if (m.style === "layered" && m.layers > CONFIG.maxLayers) {
    html += `<li class="status error">That’s a lot of layers – try a bigger contour interval for a quicker, cheaper piece.</li>`;
  }
  $("#stats").innerHTML = html;
}

// ---------- Result: 3D view, flat plan, scale ----------
let viewer = null;

function mapScale() {
  const m = lastResult.meta;
  return groundWidthMetres(m.bounds) / (m.widthMm / 1000);
}

// How much taller the hills look than true scale, in plain words.
function exaggeration(t) {
  const x = (t / 1000) * mapScale() / lastResult.meta.interval;
  if (x < 1.3) return "so the hills are close to their true shape";
  return `so the hills look about ${x < 3 ? x.toFixed(1) : Math.round(x)}× steeper than real life`;
}

function render3d() {
  if (!lastResult) return;
  try {
    viewer ??= createViewer($("#viewer"));
    viewer.show(lastResult, { thickness: +$("#thickness").value, material: materialByName($("#material").value).look });
  } catch (err) {
    // No WebGL: fall back to the flat plan.
    console.error(err);
    selectTab("plan");
    $("#tab-3d").hidden = true;
  }
  const m = lastResult.meta;
  const scale = (Math.round(mapScale() / 100) * 100).toLocaleString("en-GB");
  const t = +$("#thickness").value;
  $("#scale-note").innerHTML =
    m.style === "layered"
      ? `<b>${sizeText(m)}</b>, <b>${m.layers} layers × ${t} mm = ${m.layers * t} mm tall</b>. ` +
        `Map scale 1:${scale}. Each layer is ${m.interval} m of height, ${exaggeration(t)}. The ruler is in centimetres.`
      : `<b>${sizeText(m)}</b> board. Map scale 1:${scale}, contours every ${m.interval} m. The ruler is in centimetres.`;
}

function selectTab(which) {
  const is3d = which === "3d";
  $("#tab-3d").setAttribute("aria-selected", is3d);
  $("#tab-plan").setAttribute("aria-selected", !is3d);
  $("#viewer").hidden = !is3d;
  $("#preview").hidden = is3d;
  if (is3d) viewer?.start();
  else viewer?.stop();
}
$("#tab-3d").addEventListener("click", () => selectTab("3d"));
$("#tab-plan").addEventListener("click", () => selectTab("plan"));
$("#result").addEventListener("close", () => viewer?.stop());

function showResult() {
  $("#preview").innerHTML = lastResult.preview;
  $("#send-request").disabled = false;
  $("#send-request").textContent = ETSY ? "Save my design" : "Send request";
  $("#etsy-done").hidden = true;
  renderStats();
  $("#order-status").textContent = "";
  $("#owner-note").textContent = "";
  $("#cost-table").innerHTML = "";
  $("#result").showModal();
  if (!$("#tab-3d").hidden) selectTab("3d");
  render3d();
}

// Material and thickness: only the thicknesses the supplier sells in each material.
$("#material").innerHTML = MATERIALS.materials.map((m) => `<option>${escapeHtml(m.name)}</option>`).join("");
$("#material").value = materialByName(state.material).name;
function fillThicknesses() {
  const m = materialByName($("#material").value);
  const keep = +$("#thickness").value || state.thickness;
  $("#thickness").innerHTML = m.thicknesses.map((t) => `<option value="${t.mm}">${t.mm} mm</option>`).join("");
  // Keep the chosen thickness if this material has it, else the nearest.
  const best = m.thicknesses.reduce((a, t) => (Math.abs(t.mm - keep) < Math.abs(a.mm - keep) ? t : a));
  $("#thickness").value = String(best.mm);
}
fillThicknesses();
$("#material").addEventListener("change", fillThicknesses);
for (const id of ["#thickness", "#material"]) {
  $(id).addEventListener("change", () => {
    $("#cost-table").innerHTML = "";
    if (!lastResult) return;
    lastResult.link = shareLink(lastResult.bounds, lastResult.ref);
    renderStats();
    render3d();
  });
}

// ---------- Owner mode: only the shop owner's browser can download the SVG ----------
const OWNER_STORE = "tm-owner-key-hash";
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function setOwnerMode(on) {
  for (const el of document.querySelectorAll(".owner-only")) el.hidden = !on;
  $("#owner-badge").hidden = !on;
}
async function initOwnerMode() {
  const store = {
    get: () => { try { return localStorage.getItem(OWNER_STORE); } catch { return null; } },
    set: (v) => { try { v ? localStorage.setItem(OWNER_STORE, v) : localStorage.removeItem(OWNER_STORE); } catch { /* private mode */ } },
  };
  let hash = store.get();
  const key = params.get("owner");
  if (key && crypto.subtle) {
    hash = await sha256(key);
    params.delete("owner");
    history.replaceState(null, "", `${location.pathname}${params.size ? "?" + params : ""}`);
  }
  const ok = !!CONFIG.ownerKeyHash && hash === CONFIG.ownerKeyHash;
  store.set(ok ? hash : null);
  setOwnerMode(ok);
  $("#owner-exit").addEventListener("click", () => {
    store.set(null);
    setOwnerMode(false);
  });
}
initOwnerMode();

$("#download").addEventListener("click", () => {
  const btn = $("#download");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing pieces…";
  // Let the button update before the (few seconds of) work starts.
  setTimeout(() => {
    try {
      // Assembled model plus the pieces laid flat on cutting sheets.
      lastResult.svg ??= lastResult.buildSvg(CONFIG.sheet);
      const { text, sheets, oversize } = lastResult.svg;
      const blob = new Blob([text], { type: "image/svg+xml" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `contour-layout-${lastResult.ref}.svg` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      if (sheets) {
        const s = CONFIG.sheet;
        $("#owner-note").textContent =
          `Includes ${sheets} cutting sheet${sheets > 1 ? "s" : ""} of ${s.w} × ${s.h} mm` +
          (oversize ? ` – ${oversize} piece${oversize > 1 ? "s are" : " is"} bigger than a sheet (marked OVERSIZE).` : ".");
      }
    } catch (err) {
      console.error(err);
      $("#owner-note").textContent = "Couldn’t build the SVG – please try again.";
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }, 50);
});

$("#copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastResult.link);
    $("#copy-link").textContent = "Link copied ✓";
  } catch {
    prompt("Copy this link:", lastResult.link);
  }
  setTimeout(() => ($("#copy-link").textContent = "Copy share link"), 2000);
});

$("#order").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const m = lastResult.meta;
  const summary = [
    `Reference: ${lastResult.ref}`,
    `Board: ${sizeText(m)}, ${m.style === "layered" ? `${m.layers} layers at ${fd.thickness} mm (≈${stackHeight()} mm)` : "single engraved board"}`,
    `Contours every ${m.interval} m, smoothing ${m.smoothing}, heights ${m.minElevation}-${m.maxElevation} m`,
    `Material: ${fd.material}`,
    ...(BODY !== "earth" ? [`World: ${WORLD.label}${siteName(m.bounds) ? ` – ${siteName(m.bounds)}` : ""}`] : []),
    ...lastResult.places.map(
      (p) => `Special place: ${SHAPES[p.shape].label} "${p.label || "(no label)"}" at ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} (${p.sizeMm} mm marker)`
    ),
    ...(state.water.size && !lastResult.waterFailed ? [`Water: ${waterLabel()}`] : []),
    ...(state.roads.size && !lastResult.waterFailed ? [`Roads: ${roadLabel()}`] : []),
    ...(lastResult.routeOnBoard
      ? [`Route: ${routeLengthKm(state.route.lines).toFixed(1)} km, ${state.route.style} line, ${state.route.widthMm} mm (included in the design link)`]
      : []),
    `Area (W,S,E,N): ${[m.bounds.west, m.bounds.south, m.bounds.east, m.bounds.north].map((v) => v.toFixed(5)).join(", ")}`,
    `Open the design: ${lastResult.link}`,
    "",
    `Notes: ${fd.notes || "-"}`,
  ].join("\n");
  const status = $("#order-status");
  const subject = `Contour map request ${lastResult.ref}`;
  if (ETSY) return saveForEtsy(fd, summary);

  // Send from the page when a form service is set up (Web3Forms or Formspree).
  const service = CONFIG.web3formsKey
    ? {
        url: "https://api.web3forms.com/submit",
        body: {
          access_key: CONFIG.web3formsKey,
          subject,
          from_name: `${CONFIG.businessName} website`,
          name: fd.name,
          email: fd.email,
          replyto: fd.email,
          message: summary,
          botcheck: !!fd.botcheck,
        },
      }
    : CONFIG.formEndpoint
      ? { url: CONFIG.formEndpoint, body: { name: fd.name, email: fd.email, _subject: subject, message: summary } }
      : null;
  if (service) {
    const btn = $("#send-request");
    btn.disabled = true;
    status.textContent = "Sending…";
    status.className = "status";
    try {
      const res = await fetch(service.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(service.body),
      });
      const reply = await res.json().catch(() => ({}));
      if (!res.ok || reply.success === false) throw new Error(reply.message || res.status);
      status.textContent = `Thanks ${fd.name}! We’ve got your layout (${lastResult.ref}) and will be in touch soon.`;
      status.className = "status ok";
      btn.textContent = "Request sent ✓"; // stays disabled so it isn't sent twice
    } catch {
      status.textContent = `Couldn’t send just now. Please try again, or copy the share link and email it to ${CONFIG.orderEmail}.`;
      status.className = "status error";
      btn.disabled = false;
    }
    return;
  }

  const body = `Hi,\n\nI'd like a laser-cut contour map of this layout.\n\n${summary}\n\nName: ${fd.name}\nEmail: ${fd.email}\n`;
  location.href = `mailto:${CONFIG.orderEmail}?subject=${encodeURIComponent(`Contour map request ${lastResult.ref}`)}&body=${encodeURIComponent(body)}`;
  status.textContent = "Your email app should open with your layout link and details filled in – just press send.";
  status.className = "status ok";
});

if (state.template) {
  const s = sizeOf(state.template);
  state.w = s.w;
  state.h = s.h;
}
renderSizes();
renderFrameTemplate();

// ---------- Step 4: special places ----------
const MAX_PLACES = 3;
const MARKER_PX = 30;
const markers = [];

function markerElement(p) {
  const el = document.createElement("div");
  el.className = "place-marker";
  el.innerHTML = shapeIcon(p.shape, MARKER_PX, 'fill="#b9581f" stroke="#fff" stroke-width="0.07"') + `<span></span>`;
  el.querySelector("span").textContent = p.label;
  el.title = "Drag to move";
  return el;
}

// Put the shape's anchor point (e.g. the tip of the pin) on the spot.
function markerOffset(shape) {
  const [ax, ay] = SHAPES[shape].anchor;
  const unit = MARKER_PX / 1.1; // icon viewBox is 1.1 units wide
  return [-(0.05 + ax) * unit, -(0.05 + ay) * unit];
}

function addMarker(p, i) {
  const marker = new maplibregl.Marker({ element: markerElement(p), anchor: "top-left", offset: markerOffset(p.shape), draggable: true })
    .setLngLat([p.lng, p.lat])
    .addTo(map);
  marker.on("dragend", () => {
    const { lng, lat } = marker.getLngLat();
    Object.assign(state.places[i], { lng, lat });
  });
  markers[i] = marker;
}

function refreshMarkers() {
  markers.splice(0).forEach((m) => m.remove());
  state.places.forEach(addMarker);
}

function renderPlaces() {
  $("#places").innerHTML = state.places
    .map(
      (p, i) => `
      <div class="place" data-i="${i}">
        <div class="place-head">
          <span>Place ${i + 1}</span>
          <button type="button" class="link-btn remove-place">Remove</button>
        </div>
        <div class="shape-picker" role="radiogroup" aria-label="Shape for place ${i + 1}">
          ${Object.entries(SHAPES)
            .map(([id, s]) => `<button type="button" class="shape-btn" role="radio" aria-checked="${id === p.shape}" data-shape="${id}" title="${s.label}" aria-label="${s.label}">${shapeIcon(id, 20)}</button>`)
            .join("")}
        </div>
        <label class="field"><span>Label (optional)</span>
          <input class="place-label" maxlength="40" placeholder="e.g. Where we got engaged" value="${escapeHtml(p.label)}">
        </label>
      </div>`
    )
    .join("");
  $("#add-place").hidden = state.places.length >= MAX_PLACES;
  $(".place-size").hidden = !state.places.length;
  refreshMarkers();
}

$("#add-place").addEventListener("click", () => {
  if (state.places.length >= MAX_PLACES) return;
  // Start in the middle of the frame, nudged so new markers don't stack.
  const r = frameRect();
  const n = state.places.length;
  const at = map.unproject([r.x + r.w / 2 + n * 36, r.y + r.h / 2 + n * 24]);
  state.places.push({ lng: at.lng, lat: at.lat, shape: DEFAULT_SHAPE, label: "" });
  renderPlaces();
  $(`.place[data-i="${n}"] .place-label`)?.focus();
});

$("#places").addEventListener("click", (e) => {
  const row = e.target.closest(".place");
  if (!row) return;
  const i = +row.dataset.i;
  if (e.target.closest(".remove-place")) {
    state.places.splice(i, 1);
    renderPlaces();
    return;
  }
  const btn = e.target.closest(".shape-btn");
  if (btn) {
    state.places[i].shape = btn.dataset.shape;
    row.querySelectorAll(".shape-btn").forEach((b) => b.setAttribute("aria-checked", b === btn));
    refreshMarkers();
  }
});

$("#places").addEventListener("input", (e) => {
  if (!e.target.classList.contains("place-label")) return;
  const i = +e.target.closest(".place").dataset.i;
  state.places[i].label = e.target.value;
  markers[i].getElement().querySelector("span").textContent = e.target.value;
});

$("#place-size").innerHTML = PLACE_SIZES.map((s) => `<option value="${s.mm}">${s.label} (${s.mm} mm)</option>`).join("");
$("#place-size").value = String(state.placeMm);
$("#place-size").addEventListener("change", (e) => (state.placeMm = +e.target.value));

renderPlaces();

// ---------- Step 5: hiking route ----------
let drawing = false;
let draft = [];

const lineFeatures = (lines) => ({
  type: "FeatureCollection",
  features: lines.map((l) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l } })),
});

function setRouteStatus(msg, kind = "") {
  $("#route-status").textContent = msg;
  $("#route-status").className = `status ${kind}`;
}

function routeBounds(lines) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of lines.flat()) {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  }
  // A little breathing room around the route.
  const px = (b[2] - b[0]) * 0.08, py = (b[3] - b[1]) * 0.08;
  return [b[0] - px, b[1] - py, b[2] + px, b[3] + py];
}

function routeFitsFrame(lines) {
  const f = frameBounds();
  return lines.flat().every(([x, y]) => x >= f.west && x <= f.east && y >= f.south && y <= f.north);
}

function renderRoute() {
  const has = state.route.lines.length > 0;
  onStyleReady(() => {
    map.getSource("route").setData(lineFeatures(state.route.lines));
    map.setPaintProperty("route-line", "line-dasharray", state.route.style === "dashed" ? [2, 1.4] : null);
  });
  $("#route-info").hidden = !has || drawing;
  $("#route-draw").textContent = has ? "Redraw on map" : "Draw on map";
  if (has) {
    const km = routeLengthKm(state.route.lines);
    $("#route-summary").innerHTML = `<b>${km.toFixed(1)} km route</b>${state.route.lines.length > 1 ? ` in ${state.route.lines.length} parts` : ""}.`;
  }
  $("#route-style").value = state.route.style;
  $("#route-width").value = String(state.route.widthMm);
}

// Store routes as they will travel in the share link, so the customer's
// preview and the owner's file are built from exactly the same line.
function setRoute(lines) {
  state.route.lines = decodeRoute(encodeRoute(lines));
  renderRoute();
}

function updateDraft() {
  const features = draft.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }));
  if (draft.length > 1) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: draft } });
  map.getSource("route-draft").setData({ type: "FeatureCollection", features });
  $("#route-points").textContent = draft.length ? `${draft.length} point${draft.length > 1 ? "s" : ""} · ${routeLengthKm([draft]).toFixed(1)} km` : "";
}

function startDrawing() {
  drawing = true;
  draft = [];
  updateDraft();
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = "crosshair";
  $("#route-drawing").hidden = false;
  $("#route-info").hidden = true;
  setRouteStatus("");
}

function stopDrawing(keep) {
  drawing = false;
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = "";
  $("#route-drawing").hidden = true;
  if (keep && draft.length > 1) setRoute([draft]);
  else if (keep) setRouteStatus("A route needs at least two points.", "error");
  draft = [];
  updateDraft();
  renderRoute();
}

map.on("click", (e) => {
  if (!drawing) return;
  draft.push([e.lngLat.lng, e.lngLat.lat]);
  updateDraft();
});
map.on("dblclick", () => drawing && stopDrawing(true));
document.addEventListener("keydown", (e) => {
  if (!drawing) return;
  if (e.key === "Enter") stopDrawing(true);
  if (e.key === "Escape") stopDrawing(false);
});

$("#route-draw").addEventListener("click", startDrawing);
$("#route-undo").addEventListener("click", () => {
  draft.pop();
  updateDraft();
});
$("#route-done").addEventListener("click", () => stopDrawing(true));

$("#route-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const lines = parseRouteFile(await file.text(), file.name);
    if (!lines.length) throw new Error("no route");
    setRoute(lines);
    if (!routeFitsFrame(state.route.lines)) {
      pinnedBounds = null;
      fitFrameTo(routeBounds(state.route.lines), 600);
    }
    setRouteStatus(`Loaded ${file.name}.`, "ok");
  } catch {
    setRouteStatus("Couldn’t find a route in that file. Try a GPX, KML or GeoJSON track.", "error");
  }
});
$(".file-btn").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("#route-file").click();
  }
});

$("#route-fit").addEventListener("click", () => {
  pinnedBounds = null;
  fitFrameTo(routeBounds(state.route.lines), 600);
});
$("#route-clear").addEventListener("click", () => {
  state.route.lines = [];
  renderRoute();
  setRouteStatus("");
});
$("#route-style").addEventListener("change", (e) => {
  state.route.style = e.target.value;
  renderRoute();
});
$("#route-width").addEventListener("change", (e) => (state.route.widthMm = +e.target.value));

onStyleReady(renderRoute);

// ---------- Water: rivers, lakes and coastline ----------
const waterLabel = () =>
  WATER_KINDS.filter((k) => state.water.has(k.id))
    .map((k) => k.label.split(/[ ,&]/)[0].toLowerCase())
    .join(", ");

// Only the kinds the customer picked, from whatever was fetched.
async function waterFor(bounds) {
  const kinds = [...state.water];
  if (!kinds.length) return null;
  const all = await fetchWater(bounds, kinds);
  return Object.fromEntries(kinds.map((k) => [k, all[k]]));
}

const WATER_MAX_METRES = 40000;
let waterTimer;

async function showWater() {
  const note = $("#water-note");
  const empty = { type: "FeatureCollection", features: [] };
  if (!state.water.size) {
    map.getSource("water").setData(empty);
    note.textContent = "";
    return;
  }
  // Fetch the visible map, not just the frame, so panning a little needs no refetch.
  const c = map.getContainer();
  const nw = map.unproject([0, 0]), se = map.unproject([c.clientWidth, c.clientHeight]);
  const view = { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
  if (groundWidthMetres(view) > WATER_MAX_METRES) {
    map.getSource("water").setData(empty);
    note.textContent = "Zoom in to see rivers and lakes on the map.";
    return;
  }
  note.textContent = "Loading rivers and lakes…";
  try {
    const water = await waterFor(view);
    const features = Object.entries(water).flatMap(([kind, lines]) =>
      lines.map((l) => ({ type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates: l } }))
    );
    map.getSource("water").setData({ type: "FeatureCollection", features });
    note.textContent = "Water © OpenStreetMap contributors.";
  } catch {
    note.textContent = "Couldn’t load rivers and lakes just now.";
  }
}
const showWaterSoon = () => {
  clearTimeout(waterTimer);
  waterTimer = setTimeout(showWater, 700);
};

$("#water-kinds").innerHTML = WATER_KINDS.map(
  (k) => `<label class="check"><input type="checkbox" value="${k.id}" ${state.water.has(k.id) ? "checked" : ""}> ${k.label}</label>`
).join("");
$("#water-kinds").addEventListener("change", (e) => {
  if (e.target.checked) state.water.add(e.target.value);
  else state.water.delete(e.target.value);
  showWaterSoon();
});
map.on("moveend", showWaterSoon);
onStyleReady(showWaterSoon);

// ---------- Roads and paths ----------
const roadLabel = () =>
  ROAD_KINDS.filter((k) => state.roads.has(k.id))
    .map((k) => k.label.toLowerCase())
    .join(", ");

async function roadsFor(bounds) {
  const kinds = [...state.roads];
  return kinds.length ? fetchRoads(bounds, kinds) : null;
}

const ROAD_MAX_METRES = 30000;
let roadTimer;
async function showRoads() {
  const note = $("#road-note");
  const empty = { type: "FeatureCollection", features: [] };
  if (!state.roads.size) {
    map.getSource("roads").setData(empty);
    note.textContent = "";
    return;
  }
  const c = map.getContainer();
  const nw = map.unproject([0, 0]), se = map.unproject([c.clientWidth, c.clientHeight]);
  const view = { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
  if (groundWidthMetres(view) > ROAD_MAX_METRES) {
    map.getSource("roads").setData(empty);
    note.textContent = "Zoom in to see roads on the map.";
    return;
  }
  note.textContent = "Loading roads…";
  try {
    const roads = await roadsFor(view);
    const features = Object.entries(roads).flatMap(([kind, lines]) =>
      lines.map((l) => ({ type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates: l } }))
    );
    map.getSource("roads").setData({ type: "FeatureCollection", features });
    note.textContent = "Roads © OpenStreetMap contributors.";
  } catch {
    note.textContent = "Couldn’t load roads just now.";
  }
}
const showRoadsSoon = () => {
  clearTimeout(roadTimer);
  roadTimer = setTimeout(showRoads, 700);
};
$("#road-kinds").innerHTML = ROAD_KINDS.map(
  (k) => `<label class="check"><input type="checkbox" value="${k.id}" ${state.roads.has(k.id) ? "checked" : ""}> ${k.label}</label>`
).join("");
$("#road-kinds").addEventListener("change", (e) => {
  if (e.target.checked) state.roads.add(e.target.value);
  else state.roads.delete(e.target.value);
  showRoadsSoon();
});
map.on("moveend", showRoadsSoon);
onStyleReady(showRoadsSoon);

// ---------- Etsy mode ----------
// The order and payment happen on Etsy; this only saves the design and gives
// the customer a code to paste into the Etsy personalisation box.
let etsyCopyText = "";

if (ETSY) {
  $("#order-title").textContent = "Order on Etsy";
  $("#etsy-intro").hidden = false;
  $("#email-field").hidden = true;
  $("#email-field input").required = false;
  $("#name-field input").required = false;
  $("#name-field span").textContent = "Your name (optional, helps us match your order)";
  $("#send-request").textContent = "Save my design";
  const buy = $("#etsy-buy");
  if (CONFIG.etsy?.listingUrl) buy.href = CONFIG.etsy.listingUrl;
  else buy.hidden = true;
}

async function saveForEtsy(fd, summary) {
  const btn = $("#send-request");
  const status = $("#order-status");
  const ref = lastResult.ref;
  btn.disabled = true;
  status.className = "status";
  let saved = false;
  // With a form service, the design is emailed to the shop under its code,
  // so the short code is all the customer needs to paste into Etsy.
  if (CONFIG.web3formsKey || CONFIG.formEndpoint) {
    status.textContent = "Saving your design…";
    const message = `${summary}\n\nEtsy mode: the customer will order and pay on Etsy, quoting ${ref}.`;
    const body = CONFIG.web3formsKey
      ? { access_key: CONFIG.web3formsKey, subject: `Etsy design ${ref}`, from_name: `${CONFIG.businessName} website`, name: fd.name || "Etsy customer", message, botcheck: !!fd.botcheck }
      : { name: fd.name || "Etsy customer", _subject: `Etsy design ${ref}`, message };
    try {
      const res = await fetch(CONFIG.web3formsKey ? "https://api.web3forms.com/submit" : CONFIG.formEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const reply = await res.json().catch(() => ({}));
      saved = res.ok && reply.success !== false;
    } catch {
      saved = false;
    }
  }
  // Without one (or if saving failed), the customer pastes the full design link.
  etsyCopyText = saved ? ref : `${ref} ${lastResult.link}`;
  $("#etsy-code").textContent = ref;
  $("#etsy-copy").textContent = saved ? "Copy code" : "Copy code and design link";
  $("#etsy-help").textContent = saved
    ? "Paste this code into the personalisation box when you buy on Etsy. We have your design saved under it."
    : "Paste this into the personalisation box when you buy on Etsy. It includes your design link, so we can make exactly what you designed." +
      (etsyCopyText.length > 1000 ? " If it doesn't fit, send it to us in an Etsy message instead." : "");
  status.textContent = "";
  $("#etsy-done").hidden = false;
  btn.textContent = "Design saved ✓";
}

$("#etsy-copy").addEventListener("click", async () => {
  const btn = $("#etsy-copy");
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(etsyCopyText);
    btn.textContent = "Copied ✓";
  } catch {
    prompt("Copy this:", etsyCopyText);
  }
  setTimeout(() => (btn.textContent = label), 2000);
});

// ---------- Owner: material cost ----------
// Lays the pieces out on every sheet size the supplier sells in the chosen
// material and thickness, and prices each option.
const money = (v) => `£${v.toFixed(2)}`;
$("#cost-btn").addEventListener("click", () => {
  const btn = $("#cost-btn");
  btn.disabled = true;
  btn.textContent = "Laying out pieces…";
  setTimeout(() => {
    try {
      const m = materialByName($("#material").value);
      const t = m.thicknesses.find((x) => x.mm === +$("#thickness").value) || m.thicknesses[0];
      const { pieces, areaMm2, options } = lastResult.buildCost(t.sheets, CONFIG.sheet);
      const priced = options.filter((x) => x.cost != null);
      const cheapest = priced.reduce((a, x) => (!a || x.cost < a.cost ? x : a), null);
      // Area actually used, priced at the cheapest rate per m² on offer.
      const perM2 = Math.min(...t.sheets.map((s) => s.price / ((s.w * s.h) / 1e6)));
      const usedCost = (areaMm2 / 1e6) * perM2;
      const vat = 1 + MATERIALS.vat;
      $("#cost-table").innerHTML =
        `<p class="cost-title">${escapeHtml(m.name)}, ${t.mm} mm · ${pieces} piece${pieces > 1 ? "s" : ""}, ${(areaMm2 / 1e6).toFixed(3)} m² of wood</p>` +
        `<table><thead><tr><th>Sheet</th><th>Code</th><th>Each</th><th>Sheets</th><th>Cost ex VAT</th><th>inc VAT</th></tr></thead><tbody>` +
        options
          .map((x) =>
            `<tr class="${x === cheapest ? "best" : ""}"><td>${x.w} × ${x.h}</td><td><a href="${x.url}" target="_blank" rel="noopener">${x.code}</a></td><td>${money(x.price)}</td>` +
            (x.cost == null ? `<td colspan="3">a piece is bigger than this sheet</td>` : `<td>${x.sheets}</td><td>${money(x.cost)}</td><td>${money(x.cost * vat)}</td>`) +
            `</tr>`
          )
          .join("") +
        `</tbody></table>` +
        (cheapest
          ? `<p class="cost-note">Cheapest: <b>${cheapest.sheets} × ${cheapest.w} × ${cheapest.h}</b> for <b>${money(cheapest.cost)}</b> ex VAT (${money(cheapest.cost * vat)} inc VAT). ` +
            `The wood the pieces actually use is worth about ${money(usedCost)} ex VAT, if you count offcuts as reusable. ` +
            `${MATERIALS.supplier} prices, 1+ quantity.</p>`
          : `<p class="cost-note">No ${MATERIALS.supplier} sheet in this material is big enough for the largest piece.</p>`);
    } catch (err) {
      console.error(err);
      $("#cost-table").innerHTML = `<p class="status error">Couldn’t work out the cost – please try again.</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Work out material cost";
    }
  }, 50);
});

// ---------- Place names: cities, towns and villages ----------
let townIndex = [];
const townsReady = fetch("data/places.json")
  .then((r) => r.json())
  .then((d) => (townIndex = d.places))
  .catch(() => (townIndex = []));

function placesInFrame(b) {
  const kinds = state.placeNames;
  return townIndex
    .filter(([, k, lng, lat]) => kinds.includes(k) && lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north)
    .map(([name, kind, lng, lat]) => ({ name, kind, lng, lat }));
}

async function showPlaceNames() {
  await townsReady;
  const kinds = BODY === "earth" ? state.placeNames : "none";
  const features =
    kinds === "none"
      ? []
      : townIndex
          .filter(([, k]) => kinds.includes(k))
          .map(([name, kind, lng, lat]) => ({ type: "Feature", properties: { name, kind }, geometry: { type: "Point", coordinates: [lng, lat] } }));
  onStyleReady(() => map.getSource("towns").setData({ type: "FeatureCollection", features }));
}
showPlaceNames();
