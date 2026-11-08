/* global maplibregl, mlcontour */
import { CONFIG, REGIONS, HILL_LISTS } from "./config.js";
import { buildLayout, DEM_URL, EARTH_DEM } from "./layout.js";
import { createViewer } from "./viewer3d.js";
import { SHAPES, DEFAULT_SHAPE, PLACE_SIZES, shapeIcon } from "./shapes.js";
import { parseRouteFile, encodeRoute, decodeRoute, routeLengthKm } from "./route.js";
import { WATER_KINDS, ROAD_KINDS, fetchWater, fetchSea, fetchRoads, fetchCoastOverview } from "./water.js";

// Which product page this is (body data-page): it only offers its own sizes.
const PAGE = CONFIG.pages?.[document.body.dataset.page] ? document.body.dataset.page : "maps";
const PAGE_INFO = CONFIG.pages?.[PAGE] || { title: "Contour Map Designer", sizes: CONFIG.sizes.map((s) => s.id) };
// A link for a board made on another page (e.g. an older link to a clock on
// the maps page) goes to that page, with the same design.
{
  const tpl = new URLSearchParams(location.search).get("tpl");
  const home = tpl && !PAGE_INFO.sizes.includes(tpl) && Object.values(CONFIG.pages || {}).find((p) => p.sizes.includes(tpl));
  if (home) location.replace(new URL(home.path, document.baseURI).href + location.search);
}
CONFIG.sizes = CONFIG.sizes.filter((s) => PAGE_INFO.sizes.includes(s.id));

const $ = (s) => document.querySelector(s);
const FONT = ["NotoSans-Regular"];
const FONT_BOLD = ["NotoSans-Bold"];
// MapLibre needs an absolute glyph URL; the fonts ship with the site.
// Pages in their own folders (clocks/, …) set <base href="../">, so site files
// resolve against the document's base address, not the page's own.
const GLYPHS = new URL("fonts/", document.baseURI).href + "{fontstack}/{range}.pbf";

// ---------- State (also round-tripped through the share link) ----------
const params = new URLSearchParams(location.search);
// Links can be edited by anyone, so every value read from one is checked:
// numbers are kept in range and choices must be ones the page offers.
const num = (key, lo, hi, fallback) => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};
const oneOf = (key, allowed, fallback) => (allowed.includes(params.get(key)) ? params.get(key) : fallback);
const optionValues = (id) => [...document.querySelectorAll(`#${id} option`)].map((o) => o.value);
const MAX_TEXTS = 3, TEXT_MAX_CHARS = 120, TEXT_MAX_LINES = 4;
const TEXT_MIN_MM = 2, TEXT_MAX_MM = 20, TEXT_PAD_MM = 1.2; // pad matches layout.js
// Text height in mm, in half-millimetre steps; old links without one get the peak label size.
const textSize = (v) =>
  Number.isFinite(+v) && +v > 0 ? Math.min(TEXT_MAX_MM, Math.max(TEXT_MIN_MM, Math.round(+v * 2) / 2)) : +params.get("font") || 3.5;
const cleanText = (s) => String(s || "").replace(/\r/g, "").split("\n").slice(0, TEXT_MAX_LINES).join("\n").slice(0, TEXT_MAX_CHARS);
// Whether the link carries a usable custom shape (worked out again below, once
// the helpers exist; this only checks it can be decoded).
function customShapeFromLink() {
  try {
    return (decodeRoute(params.get("cs") || "")[0] || []).length >= 3;
  } catch {
    return false;
  }
}
function boardSize() {
  const tpl = CONFIG.sizes.find((s) => s.template && s.id === params.get("tpl") && (s.id !== "custom" || customShapeFromLink()));
  const s = tpl || CONFIG.sizes.find((x) => !x.template && x.w === +params.get("w") && x.h === +params.get("h")) || CONFIG.sizes[0];
  return { w: s.w, h: s.h };
}
const state = {
  // Only the board sizes on offer: a link with any other size gets the first one.
  ...boardSize(),
  interval: +oneOf("ci", optionValues("interval"), "50"),
  smoothing: +oneOf("sm", ["0", "1", "2", "3"], "1"),
  style: params.get("style") === "engraved" ? "engraved" : "layered",
  labelMode: oneOf("labels", ["none", "name", "name-height"], "name-height"),
  fontMm: +oneOf("font", optionValues("font-mm"), "3.5"),
  // Place names to label: "none", "c" cities, "ct" + towns, "ctv" + villages.
  placeNames: ["c", "ct", "ctv"].includes(params.get("pn")) ? params.get("pn") : "none",
  placeFontMm: +oneOf("pfont", optionValues("place-font-mm"), "3.5"),
  labelBoxes: params.get("lbox") === "1",
  labels3d: params.get("l3d") === "1", // layered: labels on raised flat patches
  contours: params.get("cl") !== "0",
  frame: params.get("fr") === "1",
  qty: Math.min(10, Math.max(1, Math.round(+params.get("qty") || 1))), // coasters in a set // optional frame (single engraved boards on sizes that offer it)
  // Every bundled hill list is named (and Moon/Mars features); no per-list choice.
  lists: new Set([...HILL_LISTS.map((l) => l.id), "features"]),
  sharedBounds: parseBounds(params.get("b")),
  thickness: num("t", 0.5, 20, CONFIG.defaultThickness || 3), // snapped to what the material offers
  material: (params.get("mat") || "").slice(0, 60),
  // Customers' special places: { lng, lat, shape, label }.
  places: parsePlaces(params.get("poi")),
  // Customer's own text blocks: { lng, lat, text } (centre of the text).
  texts: parseTexts(params.get("txt")),
  placeMm: PLACE_SIZES.some((s) => s.mm === +params.get("psz")) ? +params.get("psz") : PLACE_SIZES[1].mm,
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
  // A shaped board from the link, else the page's first size if it is shaped
  // (the clock, coaster and bookmark pages start on their board shape).
  template:
    params.get("tpl") === "custom"
      ? customShapeFromLink() ? "custom" : null
      : CONFIG.sizes.find((s) => s.id === params.get("tpl") && s.template)?.id ||
        (!params.get("tpl") && !CONFIG.sizes.some((s) => !s.template && s.w === +params.get("w") && s.h === +params.get("h")) && CONFIG.sizes[0].template && !CONFIG.sizes[0].custom ? CONFIG.sizes[0].id : null),
};
// Back plates for the owner's SVG (see backPlates in config.js).
let logoArt = null;
async function loadLogo() {
  const file = CONFIG.backPlates?.logo?.file || "data/logo.json";
  if (!logoArt) logoArt = await fetch(file).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return logoArt;
}
// The back of the base board: logo, data credits and the customer reference.
async function backDetails() {
  if (!CONFIG.backEngraving) return null;
  return { ...CONFIG.backEngraving, logo: await loadLogo(), credits: WORLD.plateCredits, maker: `Made by ${CONFIG.businessName}` };
}
async function backPlates() {
  const cfg = CONFIG.backPlates;
  if (!cfg) return null;
  if (cfg.logo?.file) await loadLogo();
  return {
    credits: cfg.credits ? { ...cfg.credits, ...WORLD.plateCredits, maker: `Made by ${CONFIG.businessName}` } : null,
    logo: cfg.logo && logoArt ? { ...cfg.logo, art: logoArt } : null,
  };
}
const templates = {};
const sizeOf = (id) => CONFIG.sizes.find((s) => s.id === id);
async function loadTemplate(id) {
  if (id === "custom") return templates.custom || null;
  const s = sizeOf(id);
  if (!s?.template) return null;
  templates[id] ??= await fetch(s.template).then((r) => r.json());
  return templates[id];
}
// ---------- Custom shape: a board outline the customer draws on the map ----------
const SHAPE_SIZES = [200, 300, 400, 500]; // longest side, mm
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
/**
 * Board template from a drawn ring of [lng, lat]: its outline in mm, scaled so
 * the longest side is maxMm, and the map area that exactly fits round it.
 * A ring that crosses itself is untangled (the biggest part is kept).
 */
function customTemplateFrom(ring, maxMm) {
  if (!ring || ring.length < 3) return null;
  let clean;
  try {
    const parts = polygonClipping.union([[[...ring, ring[0]]]]);
    const area = (r) => Math.abs(r.reduce((n, p, i) => n + (i ? (r[i - 1][0] - p[0]) * (r[i - 1][1] + p[1]) : 0), 0));
    clean = parts.map((p) => p[0]).sort((a, b) => area(b) - area(a))[0];
  } catch {
    return null;
  }
  if (!clean || clean.length < 4) return null;
  clean = clean.slice(0, -1); // drop the closing point
  const lngs = clean.map((p) => p[0]), lats = clean.map((p) => p[1]);
  const west = Math.min(...lngs), east = Math.max(...lngs), south = Math.min(...lats), north = Math.max(...lats);
  const x0 = (west * Math.PI) / 180, x1 = (east * Math.PI) / 180, y0 = mercY(south), y1 = mercY(north);
  if (x1 - x0 < 1e-5 || y1 - y0 < 1e-5) return null;
  const aspect = (x1 - x0) / (y1 - y0);
  const w = Math.round((aspect >= 1 ? maxMm : maxMm * aspect) * 10) / 10;
  const h = Math.round((aspect >= 1 ? maxMm / aspect : maxMm) * 10) / 10;
  if (Math.min(w, h) < 40) return { tooThin: true };
  const outline = clean.map(([lng, lat]) => [
    Math.round(((((lng * Math.PI) / 180 - x0) / (x1 - x0)) * w) * 1000) / 1000,
    Math.round((((y1 - mercY(lat)) / (y1 - y0)) * h) * 1000) / 1000,
  ]);
  return {
    template: { name: "Custom shape", w, h, outline, holes: [], mapArea: null, engrave: [] },
    bounds: { west, south, east, north },
    ring: clean,
  };
}
// From a shared link: tpl=custom with the ring (cs) and size (cm).
let customShape = null;
if (params.get("tpl") === "custom") {
  try {
    const ring = decodeRoute(params.get("cs") || "")[0];
    const max = SHAPE_SIZES.includes(+params.get("cm")) ? +params.get("cm") : 300;
    const c = customTemplateFrom(ring, max);
    if (c?.template) customShape = { ...c, maxMm: max };
  } catch {
    /* no usable shape: falls back to the first size */
  }
}
if (customShape) {
  templates.custom = customShape.template;
  Object.assign(sizeOf("custom"), { w: customShape.template.w, h: customShape.template.h });
}

// "west,south,east,north": real coordinates, west < east, south < north, and
// no bigger than 40° across: room for all of Great Britain and Ireland on any
// board shape (the elevation grid is capped, so big areas build quickly).
function parseBounds(text) {
  const b = (text || "").split(",").map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite)) return null;
  const [w, s, e, n] = b;
  const ok = w >= -180 && e <= 180 && s >= -85 && n <= 85 && w < e && s < n && e - w <= 40 && n - s <= 40;
  return ok ? b : null;
}

function safeDecodeRoute(text) {
  if (!text || text.length > 4000) return []; // routes are kept under ~1,000 characters
  try {
    return decodeRoute(text);
  } catch {
    return [];
  }
}

function parseTexts(text) {
  try {
    return JSON.parse(text || "[]")
      .slice(0, MAX_TEXTS)
      .map(([lng, lat, t, size, clear]) => ({ lng: +lng, lat: +lat, text: cleanText(t), size: textSize(size), clear: clear !== 0 }))
      .filter((t) => Number.isFinite(t.lng) && Number.isFinite(t.lat));
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
const BODY = CONFIG.worlds && ["moon", "mars"].includes(params.get("body")) ? params.get("body") : "earth";
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
    // For the credits plate on the back of the board.
    plateCredits: {
      elevation: "Elevation: Mapzen Terrain Tiles (AWS Open Data), including SRTM (NASA) and EU-DEM (Copernicus, EU). Contains Environment Agency information ©\u00a0Environment Agency and/or database right.",
      names: "Hill names and heights: Database of British and Irish Hills v18.6, CC\u00a0BY\u00a04.0.",
    },
  },
  moon: {
    label: "Moon", the: "the Moon", radius: 1737400, features: "data/planets/moon-features.geojson",
    paper: "#e2dfd9", shadow: "#36332f", highlight: "#f8f7f4", contour: "#5f5b55",
    credit: "Moon: SLDEM2015 (NASA LRO LOLA + JAXA SELENE), USGS, public domain",
    plateCredits: {
      elevation: "Elevation: SLDEM2015, from NASA LRO LOLA and JAXA SELENE (Kaguya) data, via USGS Astrogeology.",
      names: "Feature names: IAU Gazetteer of Planetary Nomenclature (IAU WGPSN / USGS).",
    },
  },
  mars: {
    label: "Mars", the: "Mars", radius: 3396190, features: "data/planets/mars-features.geojson",
    paper: "#efd6bb", shadow: "#5b3524", highlight: "#fdf1e4", contour: "#7a4b35",
    credit: "Mars: MRO CTX DTMs (NASA/JPL/MSSS), USGS, CC0",
    plateCredits: {
      elevation: "Elevation: MRO CTX digital terrain models, NASA/JPL/MSSS, processed by USGS Astrogeology (CC0).",
      names: "Feature names: IAU Gazetteer of Planetary Nomenclature (IAU WGPSN / USGS).",
    },
  },
};
const WORLD = WORLDS[BODY];
const SITES = planets ? planets.sites.filter((s) => s.body === BODY) : [];
const DEM =
  BODY === "earth"
    ? EARTH_DEM
    : { url: new URL(`data/planets/${BODY}/`, document.baseURI).href + "{z}/{x}/{y}.png", maxzoom: planets.bodies[BODY].maxzoom, sea: false };
// Each site is built to its own finest zoom. The live map uses the zoom every
// site has; a layout uses the finest zoom of the site it is in (siteDem).
// The map uses z12 elevation on Earth: finer zooms carry seams in places
// (e.g. a false trench along 5° W in Scotland) that show as stripes.
// Layouts still use the finest data, with seams removed (removeSeams in layout.js).
const MAP_DEM_MAXZOOM = BODY === "earth" ? 12 : Math.min(...SITES.map((s) => s.maxzoom));
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
document.title = `${CONFIG.businessName} – ${PAGE_INFO.title}`;
$("#brand-name").textContent = `${CONFIG.businessName} – ${PAGE_INFO.title}`;
document.querySelector(".brand-title").textContent = PAGE_INFO.title;
$("#brand-tagline").textContent = PAGE_INFO.tagline || CONFIG.tagline;
// Links between the product pages (kept in Etsy mode).
$("#site-nav").innerHTML = Object.entries(CONFIG.pages || {})
  .map(([id, p]) => `<a href="${p.path}${ETSY ? "?etsy=1" : ""}"${id === PAGE ? ' aria-current="page"' : ""}>${p.nav}</a>`)
  .join("") + `<a href="guide.html" class="nav-guide">How to</a>`;

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
      "shape-draft": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
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
      // Roads, tracks and paths: solid lines, tracks and paths in red.
      // (Kept as a list of layers so a kind can be dashed again: dashes can't
      // vary by data, so a dashed kind needs its own layer.)
      ...[
        ["road-lines", ["in", ["get", "kind"], ["literal", ["major", "minor", "lanes", "service", "tracks", "paths"]]], null],
      ].map(([id, filter, dash]) => ({
        id,
        type: "line",
        source: "roads",
        filter,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["match", ["get", "kind"], "major", "#8c4a2f", "minor", "#9a6b45", "paths", "#d0352b", "tracks", "#a8231a", "service", "#7d6a55", "#6b5a48"],
          "line-width": ["match", ["get", "kind"], "major", 2.4, "minor", 1.7, "lanes", 1.2, "service", 1, "tracks", 1.8, "paths", 1.5, 1.3],
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
        id: "shape-draft-fill",
        type: "fill",
        source: "shape-draft",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#b9581f", "fill-opacity": 0.15 },
      },
      {
        id: "shape-draft-line",
        type: "line",
        source: "shape-draft",
        filter: ["!=", ["geometry-type"], "Point"],
        paint: { "line-color": "#b9581f", "line-width": 2.5 },
      },
      {
        id: "shape-draft-pts",
        type: "circle",
        source: "shape-draft",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": ["case", ["get", "first"], 7, 4], "circle-color": "#fff", "circle-stroke-color": "#b9581f", "circle-stroke-width": 2.5 },
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
        id: "town-dots",
        type: "circle",
        source: "towns",
        paint: {
          "circle-radius": ["match", ["get", "kind"], "c", 6, "t", 4.5, 3.5],
          "circle-color": "#3d3128",
          "circle-stroke-color": "#fbf7f0",
          "circle-stroke-width": 1.5,
        },
      },
      {
        id: "town-labels",
        type: "symbol",
        source: "towns",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["match", ["get", "kind"], "c", ["literal", FONT_BOLD], ["literal", FONT]],
          "text-size": ["match", ["get", "kind"], "c", 20, "t", 16, 13.5],
          "text-offset": [0, 0.7],
          "text-anchor": "top",
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

// Padlock: freeze the map so the framed area can't be nudged by accident.
// Buttons that move the map on purpose (regions, search, fit to route) still work.
const MAP_HANDLERS = ["dragPan", "scrollZoom", "boxZoom", "doubleClickZoom", "touchZoomRotate", "keyboard"];
let mapLocked = false;
const LOCK_ICON = {
  open: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 9.6-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  shut: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/></svg>',
};
function setMapLocked(on) {
  mapLocked = on;
  for (const h of MAP_HANDLERS) on ? map[h].disable() : map[h].enable();
  document.querySelectorAll(".maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out").forEach((b) => (b.disabled = on));
  const btn = $("#map-lock");
  btn.innerHTML = on ? LOCK_ICON.shut : LOCK_ICON.open;
  btn.setAttribute("aria-pressed", on);
  btn.title = on ? "Map locked. Click to move it again" : "Lock the map so it can't move";
  $(".map-wrap").classList.toggle("locked", on);
  $(".map-hint").textContent = on
    ? "Map locked. Click the padlock (top right) to move it again."
    : "Drag and zoom the map. Whatever sits inside the frame becomes your design.";
}
map.addControl({
  onAdd() {
    const box = document.createElement("div");
    box.className = "maplibregl-ctrl maplibregl-ctrl-group";
    box.innerHTML = '<button type="button" id="map-lock" class="map-lock" aria-pressed="false"></button>';
    box.firstChild.addEventListener("click", () => setMapLocked(!mapLocked));
    return box;
  },
  onRemove() {},
}, "top-right");
setMapLocked(false);

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
  if (textMarkers) sizeTextMarkers();
  renderFrameOption();
  $("#frame-size").textContent =
    state.template === "custom" ? `Custom shape ${Math.round(state.w)} × ${Math.round(state.h)} mm` : state.template ? sizeOf(state.template).label : `${state.w} × ${state.h} mm`;
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
const hillsReady = fetch(WORLD.features)
  .then((r) => r.json())
  .then((gj) => {
    hillIndex = gj.features;
    const opts = hillIndex
      .slice()
      .sort((a, b) => a.properties.name.localeCompare(b.properties.name))
      .map((f) => `<option value="${escapeHtml(f.properties.name)} (${f.properties.h} m)"></option>`);
    $("#hill-names").innerHTML = opts.join("");
  })
  .catch(() => {});

// Search: a hill from our lists, a UK postcode (full, "LA22 9QZ", or just the
// district, "LA22"; looked up at postcodes.io), or a city, town or village.
const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const EIRCODE = /^[ACDEFHKNPRTVWXY]\d[\dW]\s*[\dACDEFHKNPRTVWXY]{4}$/i;
async function findPostcode(q) {
  const code = q.replace(/\s+/g, "").toUpperCase();
  const full = POSTCODE.test(code);
  const url = `https://api.postcodes.io/${full ? "postcodes" : "outcodes"}/${encodeURIComponent(code)}`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`postcodes.io ${r.status}`);
  const { result } = await r.json();
  if (!result || !Number.isFinite(result.longitude) || !Number.isFinite(result.latitude)) return null;
  return { name: full ? result.postcode : result.outcode, at: [result.longitude, result.latitude], zoom: full ? 13 : 11.5 };
}
let searchCall = 0;
$("#hill-search").addEventListener("change", async (e) => {
  const raw = e.target.value.trim();
  const q = raw.toLowerCase();
  const note = $("#search-note");
  note.textContent = "";
  note.classList.remove("error");
  if (!q) return;
  const call = ++searchCall;
  const fail = (msg) => {
    if (call !== searchCall) return;
    note.textContent = msg;
    note.classList.add("error");
  };
  const go = (at, zoom) => call === searchCall && map.flyTo({ center: at, zoom });
  if (BODY === "earth" && (POSTCODE.test(raw) || OUTCODE.test(raw))) {
    note.textContent = "Looking up the postcode…";
    try {
      const hit = await findPostcode(raw);
      if (call !== searchCall) return;
      note.textContent = "";
      if (hit) return go(hit.at, hit.zoom);
      return fail(`Couldn’t find the postcode “${raw}”. Check it, or search a town or hill instead.`);
    } catch {
      return fail("Couldn’t look up postcodes just now. Search a town or hill instead, or try again.");
    }
  }
  if (BODY === "earth" && EIRCODE.test(raw)) return fail("Irish Eircodes can’t be searched yet. Search a nearby town or hill instead.");
  const hit =
    hillIndex.find((f) => `${f.properties.name} (${f.properties.h} m)`.toLowerCase() === q) ||
    hillIndex.find((f) => f.properties.name.toLowerCase() === q);
  if (hit) return go(hit.geometry.coordinates, Math.max(map.getZoom(), 12));
  // Towns and villages (biggest first, as listed), then partial hill names.
  const town = BODY === "earth" ? townIndex.find(([name]) => name.toLowerCase() === q) || townIndex.find(([name]) => name.toLowerCase().startsWith(q)) : null;
  if (town) return go([town[2], town[3]], { c: 11, t: 12, v: 13 }[town[1]] || 12);
  const part = hillIndex.find((f) => f.properties.name.toLowerCase().includes(q));
  if (part) return go(part.geometry.coordinates, Math.max(map.getZoom(), 12));
  fail(`Couldn’t find “${raw}”. Try a hill, a town or village, or a UK postcode.`);
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
    `Data courtesy of NASA, JAXA and the USGS Astrogeology Science Center. <a href="licences.html">Data licences</a> · <a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a>`;
}
$(".world-switch").hidden = !CONFIG.worlds; // Moon and Mars are switched off for now
document.querySelectorAll(".world-switch a").forEach((a) => {
  a.setAttribute("aria-selected", a.dataset.body === BODY);
  // Keep the board size and style when hopping between worlds.
  const keep = new URLSearchParams({ ...(a.dataset.body !== "earth" ? { body: a.dataset.body } : {}), w: state.w, h: state.h, style: state.style });
  if (state.template) keep.set("tpl", state.template);
  if (params.get("etsy") === "1") keep.set("etsy", "1");
  a.href = location.pathname + "?" + keep; // stay on this page (clocks, coasters, …)
});

$("#regions").innerHTML = REGIONS.map((r, i) => `<button type="button" class="chip${r.phone ? "" : " not-phone"}" data-i="${i}">${r.label}</button>`).join("");
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
}
$("#sizes").addEventListener("click", (e) => {
  const s = CONFIG.sizes.find((x) => x.id === e.target.dataset.id);
  if (!s) return;
  if (s.custom) return startShapeDrawing(); // draw the outline on the map
  if (shapeDrawing) stopShapeDrawing(false);
  setSize(s.w, s.h, s.template ? s.id : null);
});
// A shared link's area is only reused if its shape matches the board.
function pinnedMatchesFrame() {
  if (!pinnedBounds) return false;
  const b = pinnedBounds;
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const aspect = (((b.east - b.west) * Math.PI) / 180) / (merc(b.north) - merc(b.south));
  return Math.abs(aspect / (state.w / state.h) - 1) < 0.02;
}

// ---------- Optional frame (single engraved boards) ----------
// Function declarations: the frame is laid out before this code runs.
function currentSize() {
  return state.template ? CONFIG.sizes.find((s) => s.id === state.template) : CONFIG.sizes.find((s) => !s.template && s.w === state.w && s.h === state.h);
}
function frameOffered() {
  return !!currentSize()?.frame;
}
function frameActive() {
  return state.frame && frameOffered();
}
// Show the checkbox only where a frame is offered, and the frame to scale on the map.
function renderFrameOption() {
  renderFrameText();
  $("#labels-3d-row").hidden = state.style === "engraved"; // only layered boards have layers to raise
  $("#frame-row").hidden = !frameOffered();
  $("#frame-on").checked = state.frame;
  const el = $("#frame-border");
  el.hidden = !frameActive();
  if (el.hidden) return;
  el.classList.toggle("round", !!state.template);
  el.style.borderWidth = `${((CONFIG.frameMm || 5) * frameRect().w) / state.w}px`;
}
// Layered boards call it a 3D frame (built up from the layers, like 3D labels).
function renderFrameText() {
  const mm = CONFIG.frameMm || 5;
  const layered = state.style !== "engraved";
  $("#frame-label").textContent = layered ? `3D frame (${mm} mm)` : `Add a ${mm} mm frame`;
  $("#frame-note").textContent = layered
    ? "A level rim round the edge, built up from the layers below to the highest ground along the edge. Names stay clear of it."
    : "Cut from the same wood and glued on top round the edge. Names stay clear of it.";
}
$("#frame-on").addEventListener("change", (e) => {
  state.frame = e.target.checked;
  renderFrameOption();
});

function setSize(w, h, template = null) {
  pinnedBounds = null; // a shared link's area no longer matches the new frame
  state.w = w;
  state.h = h;
  state.template = template;
  renderSizes();
  layoutFrame();
  renderFrameTemplate();
  updateStyleOptions();
}

// ---------- Step 3: style ----------
document.querySelectorAll('input[name="style"]').forEach((el) => {
  el.checked = el.value === state.style;
  el.addEventListener("change", () => {
    state.style = el.value;
    renderFrameOption();
  });
});
renderFrameOption();

// Contour lines off: a flat engraved board (layers are made from contours,
// so layered isn't possible), and no contours on the map either.
// Layered needs contour lines, and isn't offered for flat-only products
// (coasters and bookmarks must lie flat).
function updateStyleOptions() {
  const flatOnly = !!currentSize()?.engravedOnly;
  const layered = document.querySelector('input[name="style"][value="layered"]');
  layered.disabled = !state.contours || flatOnly;
  layered.closest("label").title = flatOnly
    ? currentSize().product
      ? "Coasters and bookmarks are single engraved boards, so they lie flat"
      : `The ${currentSize().label.toLowerCase()} is made as a single engraved board`
    : !state.contours ? "Layered boards are made from the contours – tick Contour lines to use them" : "";
  if (layered.disabled && state.style === "layered") {
    state.style = "engraved";
    document.querySelector('input[name="style"][value="engraved"]').checked = true;
  }
  renderFrameOption();
}

function applyContours() {
  const on = state.contours;
  $("#contours-on").checked = on;
  $("#contour-row").hidden = !on;
  updateStyleOptions();
  onStyleReady(() => {
    for (const id of ["contour-lines", "contour-labels"]) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  });
}
$("#contours-on").addEventListener("change", (e) => {
  state.contours = e.target.checked;
  applyContours();
});
applyContours();
$("#interval").value = String(state.interval);
$("#interval").addEventListener("change", (e) => setInterval_(+e.target.value));
$("#smoothing").value = String(state.smoothing);
$("#smoothing").addEventListener("change", (e) => (state.smoothing = +e.target.value));
$("#label-mode").value = state.labelMode;
$("#label-mode").addEventListener("change", (e) => (state.labelMode = e.target.value));
$("#font-mm").value = String(state.fontMm);
$("#font-mm").addEventListener("change", (e) => {
  state.fontMm = +e.target.value;
});
$("#place-names").value = state.placeNames;
$("#place-names").addEventListener("change", (e) => {
  state.placeNames = e.target.value;
  showPlaceNames();
});
$("#place-font-mm").value = String(state.placeFontMm);
$("#place-font-mm").addEventListener("change", (e) => (state.placeFontMm = +e.target.value));
$("#labels-3d").checked = state.labels3d;
$("#labels-3d").addEventListener("change", (e) => (state.labels3d = e.target.checked));
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
    .map((f) => ({ name: f.properties.name, h: f.properties.h, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], osm: f.properties.lists === ",osm," }));
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
    ...(state.texts.some((t) => t.text.trim())
      ? { txt: JSON.stringify(state.texts.filter((t) => t.text.trim()).map((t) => [+t.lng.toFixed(5), +t.lat.toFixed(5), t.text, t.size, t.clear ? 1 : 0])) }
      : {}),
    ...(state.route.lines.length ? { rt: encodeRoute(state.route.lines), rs: state.route.style, rw: state.route.widthMm } : {}),
    wtr: [...state.water].join(","),
    ...(state.roads.size ? { rds: [...state.roads].join(",") } : {}),
    font: state.fontMm,
    ...(state.placeNames !== "none" ? { pn: state.placeNames, pfont: state.placeFontMm } : {}),
    ...(state.labelBoxes ? { lbox: "1" } : {}),
    ...(state.labels3d ? { l3d: "1" } : {}),
    ...(state.contours ? {} : { cl: "0" }),
    ...(frameActive() ? { fr: "1" } : {}),
    ...(state.template === "custom" && customShape ? { cs: encodeRoute([customShape.ring]), cm: customShape.maxMm } : {}),
    ...(state.qty > 1 && currentSize()?.product === "coaster" ? { qty: state.qty } : {}),
    t: $("#thickness").value,
    mat: $("#material").value,
  });
  return `${location.origin}${location.pathname}?${p}`;
}

$("#generate").addEventListener("click", async () => {
  const btn = $("#generate");
  btn.disabled = true;
  // Hill and place names must be loaded, or the layout would lack labels.
  await Promise.all([hillsReady, townsReady]);
  const fromLink = pinnedMatchesFrame();
  const b = fromLink ? pinnedBounds : frameBounds();
  try {
    setStatus("Fetching elevation data…");
    // Water tiles ship with the site; if one fails to load, carry on without water.
    // Very large maps (most of a country) leave them out: thousands of tiles to
    // fetch, and far too fine to show at that scale.
    const tooBig = detailTiles(b) > DETAIL_MAX_TILES;
    let water = null, roads = null, waterFailed = false;
    if (!tooBig) {
      try {
        [water, roads] = await Promise.all([waterFor(b), roadsFor(b)]);
      } catch {
        waterFailed = true;
      }
    }
    // The sea, so the land stops at the true coastline (Earth only). Large
    // maps use the simplified coastline, and still show it if it is chosen.
    let sea = null;
    if (siteDem(b).sea && !tooBig) sea = await fetchSea(b).catch(() => null);
    else if (siteDem(b).sea) {
      const overview = await fetchCoastOverview().catch(() => null);
      sea = overview && { box: overview.box, land: overview.land };
      if (overview && state.water.has("coast")) water = { coast: overview.coast };
    }
    // Rebuilding a customer's link keeps their reference, so files match emails
    // (it is also engraved on the back).
    const ref = (fromLink && sharedRef) || makeRef();
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
        labels3d: state.labels3d,
        frameMm: frameActive() ? CONFIG.frameMm || 5 : 0,
        recess: currentSize()?.recess ? CONFIG.clockRecess : null,
        thicknessMm: +$("#thickness").value || state.thickness,
        contours: state.contours,
        dem: siteDem(b),
        template: state.template ? await loadTemplate(state.template) : null,
        places: state.places,
        texts: state.texts.filter((t) => t.text.trim()).map((t) => ({ ...t, sizeMm: t.size })),
        placeMm: state.placeMm,
        route: state.route.lines.length ? state.route : null,
        water,
        sea,
        roads,
        guides: true,
        plates: await backPlates(),
        back: await backDetails(),
        ref,
      },
      (f) => setStatus(`Fetching elevation data… ${Math.round(f * 100)}%`)
    );
    lastResult = { ...result, bounds: b, link: shareLink(b, ref), ref, waterFailed, tooBig, sizeId: currentSize()?.id };
    showResult();
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(err.userMessage || "Something went wrong building the layout. Please try again.", "error");
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
    ...(lastResult.back ? [["Back", "logo, map credits and reference engraved"]] : []),
    ...(m.frameMm ? [["Frame", m.frameLayer ? `3D, ${m.frameMm} mm, built up to layer ${m.frameLayer}` : `${m.frameMm} mm, glued on top`]] : []),
    ...(m.labels3d ? [["Labels", "3D (raised on flat patches)"]] : []),
    ...(m.raisedTemplateLayer ? [["Clock numbers", `3D, raised to layer ${m.raisedTemplateLayer}`]] : []),
    ...(m.recess ? [["Movement pocket", `${m.recess.widthMm} × ${m.recess.heightMm} mm at the back, ${m.recess.layers} layers (${m.recess.depthMm} mm) deep${m.recess.short ? " – as deep as this map allows" : ""}`]] : []),
    ["Heights", `${m.minElevation}–${m.maxElevation} m`],
    [m.style === "layered" ? "Layers" : "Contour lines", m.style === "layered" ? m.layers : m.contours ? m.layers - 1 : "off"],
    ["Named peaks", lastResult.peaksPlaced],
    ...(state.placeNames !== "none" && BODY === "earth" ? [["Place names", lastResult.townsPlaced]] : []),
    ...(lastResult.labelsLeftOff
      ? [["Names left off", `${lastResult.labelsLeftOff} (no room without overlapping – try smaller text or zoom in)`]]
      : []),
    ...(state.places.length ? [["Special places", lastResult.places.length]] : []),
    ...(wantedTexts() ? [["Your text", lastResult.texts.length]] : []),
    ...(state.route.lines.length ? [["Route", `${routeLengthKm(state.route.lines).toFixed(1)} km`]] : []),
    ...(state.water.size && !lastResult.waterFailed && !lastResult.tooBig ? [["Water", waterLabel()]] : []),
    ...(state.roads.size && !lastResult.waterFailed && !lastResult.tooBig ? [["Roads", roadLabel()]] : []),
  ];
  if (m.style === "layered") items.push(["Stack height", `≈ ${stackHeight()} mm`]);
  let html = items.map(([k, v]) => `<li>${k}: <b>${escapeHtml(v)}</b></li>`).join("");
  if (lastResult.tooBig && (state.water.size || state.roads.size)) {
    html += `<li class="status">Rivers, lakes and roads are left off maps this large, and the coastline is simplified – they would be far too fine to see. Zoom in (to about 200 km across or less) to include them.</li>`;
  } else if (lastResult.waterFailed) {
    html += `<li class="status error">Couldn’t load rivers, lakes or roads just now, so this layout has none. Close this and try again.</li>`;
  }
  if (state.route.lines.length && !lastResult.routeOnBoard) {
    html += `<li class="status error">Your route is ${m.template ? "off the board’s map area (or over a hole)" : "outside the frame"}, so not included. Close this and use “Fit frame to route”.</li>`;
  }
  const missing = state.places.length - lastResult.places.length;
  if (missing > 0) {
    html += `<li class="status error">${missing === 1 ? "One special place is" : `${missing} special places are`} ${m.template ? "off the board’s map area (or over a hole)" : "outside the frame"}, so not included. Close this, drag it inside the frame and create the layout again.</li>`;
  }
  const textsMissing = wantedTexts() - lastResult.texts.length;
  if (textsMissing > 0) {
    html += `<li class="status error">${textsMissing === 1 ? "One text box is" : `${textsMissing} text boxes are`} ${m.template ? "off the board’s map area, over a hole or" : "outside the frame or"} on top of other text, so not included. Close this, drag it to a clear spot and create the layout again.</li>`;
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

$("#viewer-flip").addEventListener("click", () => {
  if (!viewer) return;
  $("#viewer-flip").textContent = viewer.flip() ? "See the top" : "See the back";
});

function render3d() {
  if (!lastResult) return;
  $("#viewer-flip").textContent = "See the back"; // each new view starts from the top
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
      : `<b>${sizeText(m)}</b> board, <b>${t} mm thick</b>. Map scale 1:${scale}, ${m.contours ? `contours every ${m.interval} m` : "no contour lines"}. The ruler is in centimetres.`;
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

// Coasters: how many in the set (same design), with the price of each.
function renderQty() {
  const fp = fixedProduct();
  const row = $("#qty-row");
  row.hidden = !(fp && fp.maxQty > 1);
  if (row.hidden) return;
  $("#qty").innerHTML = Array.from({ length: fp.maxQty }, (_, i) => {
    const n = i + 1, each = fixedEach(fp, n);
    return `<option value="${n}">${n} ${fp.kind}${n > 1 ? "s" : ""} – ${money(each * n)}${n > 1 ? ` (${money(each)} each)` : ""}</option>`;
  }).join("");
  $("#qty").value = String(fp.qty);
}
$("#qty").addEventListener("change", (e) => {
  state.qty = +e.target.value;
  if (!lastResult) return;
  lastResult.link = shareLink(lastResult.bounds, lastResult.ref);
  renderPrice();
  renderEtsyGuide();
});

function showResult() {
  $("#preview").innerHTML = lastResult.preview;
  $("#send-request").disabled = false;
  $("#send-request").textContent = ETSY ? "Save my design" : "Send request";
  $("#etsy-done").hidden = true;
  renderStats();
  renderQty();
  renderEtsyGuide();
  $("#order-status").textContent = "";
  $("#owner-note").textContent = "";
  $("#cost-table").innerHTML = "";
  $("#result").showModal();
  renderPrice();
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
    // A layered clock's movement pocket is a number of layers that depends on
    // the thickness, so a new thickness needs the layout made again.
    if (lastResult.meta.recess && +$("#thickness").value !== lastResult.meta.thicknessMm) {
      $("#result").close();
      $("#generate").click();
      return;
    }
    renderPrice();
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
var ownerMode = false; // var: read by renderPrice, which can run before this point
function setOwnerMode(on) {
  ownerMode = on;
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
      const copies = fixedProduct()?.qty || 1;
      // Cut sheets the size of the wood to order (the cheapest sheet the
      // supplier sells in the chosen wood, as in the price and the request
      // email), so the file has exactly the sheets the order says.
      const c = quote().cheapest;
      const s = c ? { ...CONFIG.sheet, w: c.w, h: c.h } : CONFIG.sheet;
      const key = `${copies} ${s.w}x${s.h}`;
      if (lastResult.svgKey !== key) lastResult.svg = null;
      lastResult.svgKey = key;
      lastResult.svg ??= lastResult.buildSvg(s, { ref: lastResult.ref, copies });
      const { text, sheets, oversize } = lastResult.svg;
      const blob = new Blob([text], { type: "image/svg+xml" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `contour-layout-${lastResult.ref}.svg` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      if (sheets) {
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
    `Board: ${sizeText(m)}, ${m.style === "layered" ? `${m.layers} layers at ${fd.thickness} mm (≈${stackHeight()} mm)` : "single engraved board"}${m.frameMm ? (m.frameLayer ? `, with a ${m.frameMm} mm 3D frame built up to layer ${m.frameLayer}` : `, with a ${m.frameMm} mm frame on top`) : ""}`,
    `Contours every ${m.interval} m, smoothing ${m.smoothing}, heights ${m.minElevation}-${m.maxElevation} m`,
    `Material: ${fd.material}`,
    ...(fixedProduct()?.qty > 1 ? [`Quantity: ${copiesLabel(fixedProduct())}, all the same design (the SVG has them all)`] : []),
    ...(ETSY && etsyChoice() ? [`Etsy: ${etsyChoiceText(etsyChoice())}`] : []),
    ...(lastResult.back ? ["Back of base: logo, map credits and reference engraved (turn the base over left to right)"] : []),
    ...(m.labels3d ? ["Labels: 3D (each on a raised flat patch)"] : []),
    ...(m.raisedTemplateLayer ? [`Clock numbers and marks: 3D, raised to layer ${m.raisedTemplateLayer}`] : []),
    ...(m.recess ? [`Movement pocket: ${m.recess.widthMm} x ${m.recess.heightMm} mm at the back, layers 0-${m.recess.layers - 1} cut (${m.recess.depthMm} mm deep)`] : []),
    ...(lastPrice
      ? [`Price shown: ${money(lastPrice.total)} (board ${money(lastPrice.board)}${lastPrice.extras.map(([t, v]) => ` + ${t.toLowerCase()} ${money(v)}`).join("")}; sheets: ${lastPrice.sheets})`]
      : []),
    ...(BODY !== "earth" ? [`World: ${WORLD.label}${siteName(m.bounds) ? ` – ${siteName(m.bounds)}` : ""}`] : []),
    ...lastResult.places.map(
      (p) => `Special place: ${SHAPES[p.shape].label} "${p.label || "(no label)"}" at ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} (${p.sizeMm} mm marker)`
    ),
    ...lastResult.texts.map((t) => `Text: "${t.text.replace(/\n/g, " / ")}", ${t.sizeMm} mm${t.clear ? ", clear box" : ""}, at ${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}`),
    ...(state.water.size && !lastResult.waterFailed && !lastResult.tooBig ? [`Water: ${waterLabel()}`] : []),
    ...(state.roads.size && !lastResult.waterFailed && !lastResult.tooBig ? [`Roads: ${roadLabel()}`] : []),
    ...(lastResult.routeOnBoard
      ? [`Route: ${routeLengthKm(state.route.lines).toFixed(1)} km, ${state.route.style} line, ${state.route.widthMm} mm (included in the design link)`]
      : []),
    `Area (W,S,E,N): ${[m.bounds.west, m.bounds.south, m.bounds.east, m.bounds.north].map((v) => v.toFixed(5)).join(", ")}`,
    `Open the design: ${lastResult.link}`,
    "",
    `Notes: ${fd.notes || "-"}`,
    ...shopLines(),
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

// ---------- Price ----------
// Customers see: cheapest sheets for their pieces x (1 + markup), plus extras.
const PRICING = CONFIG.pricing && (!ETSY || CONFIG.pricing.showInEtsyMode) ? CONFIG.pricing : null;
const money = (v) => `£${v.toFixed(2)}`;
function extrasFor(placeCount, hasRoute, textCount = 0) {
  const PRICING = CONFIG.pricing || {}; // also used for the shop's own figures in Etsy mode
  const out = [];
  if (textCount && PRICING.perTextBlock) out.push([`${textCount} text box${textCount > 1 ? "es" : ""}`, textCount * PRICING.perTextBlock]);
  if (placeCount && PRICING.perSpecialPlace)
    out.push([`${placeCount} special place${placeCount > 1 ? "s" : ""}`, placeCount * PRICING.perSpecialPlace]);
  if (hasRoute && PRICING.route) out.push(["Hiking route", PRICING.route]);
  return out;
}
let priceToken = 0;
let lastPrice = null;
// The wood to buy and the price to charge for the current layout, material and
// thickness: the cheapest supplier sheets the pieces fit on, plus markup and extras.
// Fixed-price product of the current layout (coaster, bookmark), and how many.
function fixedProduct() {
  const size = CONFIG.sizes.find((s) => s.id === lastResult?.sizeId);
  const f = size?.product && CONFIG.pricing?.fixed?.[size.product];
  if (!f) return null;
  const qty = f.maxQty ? Math.min(f.maxQty, state.qty) : 1;
  return { ...f, kind: size.product, qty, each: fixedEach(f, qty) };
}
// Price of each item in a set of qty: every extra one takes discountPerExtra off.
const fixedEach = (f, qty) => Math.round(f.price * (1 - (f.discountPerExtra || 0) * (qty - 1)) * 100) / 100;
const copiesLabel = (fp) => `${fp.qty} ${fp.kind}${fp.qty > 1 ? "s" : ""}`;

// The band price of the current layout: [direct, Etsy] by size and layer band
// for 3 mm poplar, scaled for other woods by what this design's wood costs in
// them, plus the frame. Null when there's no band (drawn shapes, over 40 layers).
const POPLAR = MATERIALS.materials.find((x) => /^Poplar plywood \(AB/.test(x.name))?.thicknesses.find((x) => x.mm === 3);
const up99 = (v) => Math.ceil(v) - 0.01; // £12.30 -> £12.99
function bandPrice(materials, vat, P) {
  const m = lastResult.meta, sizeId = lastResult.sizeId, i = ETSY ? 1 : 0;
  const entry = P.bands?.[sizeId];
  if (!entry) return null;
  const layered = m.style !== "engraved";
  const bands = CONFIG.etsy?.guide?.layerBands || [{ upTo: 15 }, { upTo: 25 }, { upTo: 40 }];
  const bi = layered ? bands.findIndex((b) => m.layers <= b.upTo) : -1;
  const base = layered ? entry.layered?.[bi]?.[i] : entry.engraved?.[i];
  if (base == null) return null;
  // Other woods: scale by this design's wood cost against 3 mm poplar.
  let factor = 1;
  if (POPLAR) {
    const pop = lastResult.buildCost(POPLAR.sheets, CONFIG.sheet, 1).options.filter((x) => x.cost != null);
    const popCost = pop.length ? Math.min(...pop.map((x) => x.cost)) * (P.includeVat ? vat : 1) : 0;
    if (popCost > 0) factor = Math.max(1, materials / popCost);
  }
  const scale = (v) => (factor > 1.001 ? up99(v * factor) : v);
  let board = scale(base);
  let frame = 0;
  if (m.frameMm) {
    if (layered) board = up99(scale(base * (P.framePrices?.layered3dMultiplier || 3)));
    else frame = scale(P.framePrices?.engraved?.[sizeId]?.[i] || 0);
  }
  const size = CONFIG.sizes.find((s) => s.id === sizeId);
  const label = `${size?.label.replace(/ \(.*\)$/, "") || "Board"}, ${layered ? bands[bi]?.label || `${m.layers} layers` : "engraved"}${layered && m.frameMm ? ", 3D frame" : ""}`;
  return { board, frame, label, factor };
}

function quote() {
  const P = CONFIG.pricing || { markup: 0.4, includeVat: true };
  const m = materialByName($("#material").value);
  const t = m.thicknesses.find((x) => x.mm === +$("#thickness").value) || m.thicknesses[0];
  const fp = fixedProduct();
  const { options } = lastResult.buildCost(t.sheets, CONFIG.sheet, fp?.qty || 1);
  const cheapest = options.filter((x) => x.cost != null).reduce((a, x) => (!a || x.cost < a.cost ? x : a), null);
  if (!cheapest) return { material: m, thickness: t, cheapest: null };
  const vat = 1 + MATERIALS.vat;
  const materials = cheapest.cost * (P.includeVat ? vat : 1);
  const markup = ETSY && P.etsyMarkup != null ? P.etsyMarkup : P.markup; // Etsy mode covers Etsy's fees
  // Coasters and bookmarks have a standard price; other boards a band price
  // (size and layer band) where there is one, else wood + markup.
  const band = fp ? null : bandPrice(materials, vat, P);
  let board = fp ? fp.each * fp.qty : band ? band.board : materials * (1 + markup);
  // Minimum price for the size (e.g. £50 for A4), before frames and extras.
  const minimum = fp ? 0 : P.minimums?.[lastResult.sizeId] || 0;
  const atMinimum = board < minimum;
  if (atMinimum) board = minimum;
  const extras = [...(band?.frame ? [["Frame", band.frame]] : []), ...extrasFor(lastResult.places.length, lastResult.routeOnBoard, lastResult.texts.length)];
  const total = Math.round((board + extras.reduce((n, [, v]) => n + v, 0)) * 100) / 100;
  return { material: m, thickness: t, cheapest, costEx: cheapest.cost, costInc: cheapest.cost * vat, materials, board, band, atMinimum, extras, total, markup, includeVat: P.includeVat, fixed: fp };
}
// For the request email: what to order and what to charge (the shop's eyes only).
function shopLines() {
  try {
    const q = quote();
    const name = `${q.material.name}, ${q.thickness.mm} mm`;
    if (!q.cheapest) return ["", "--- For the shop ---", `Wood: no ${MATERIALS.supplier} sheet of ${name} is big enough for the largest piece. Quote by hand.`];
    const c = q.cheapest;
    return [
      "",
      "--- For the shop (not shown to the customer) ---",
      `Wood to order: ${c.sheets} x ${name}, ${c.w} x ${c.h} mm sheet (${MATERIALS.supplier} ${c.code}) at ${money(c.price)} each = ${money(q.costEx)} ex VAT / ${money(q.costInc)} inc VAT`,
      ...(c.url ? [`  ${c.url}`] : []),
      `Price to charge${ETSY ? " on Etsy" : ""}: ${money(q.total)} = ` +
        (q.fixed
          ? `${copiesLabel(q.fixed)} at ${money(q.fixed.each)} each (${money(q.board)}; standard price, materials ${money(q.materials)})`
          : q.band
            ? `${q.atMinimum ? "minimum price" : "band price"} ${money(q.board)} (${q.band.label}${q.band.factor > 1.001 ? `, ×${q.band.factor.toFixed(2)} for this wood` : ""}; materials ${money(q.materials)}${q.includeVat ? " inc VAT" : ""})`
            : `materials ${money(q.materials)}${q.includeVat ? " inc VAT" : ""} + ${Math.round(q.markup * 100)}% (${money(q.board)}; priced individually)`) +
        q.extras.map(([t, v]) => ` + ${t.toLowerCase()} ${money(v)}`).join(""),
    ];
  } catch (err) {
    console.error(err);
    return ["", "--- For the shop ---", "Couldn't work out the wood order; use owner mode's material cost."];
  }
}

function renderPrice() {
  const el = $("#price");
  lastPrice = null;
  // Hidden from customers for now (pricing.showToCustomers); owner mode still sees it.
  const ownerOnly = PRICING?.showToCustomers === false;
  if (!PRICING || !lastResult || (ownerOnly && !ownerMode)) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<p class="price-note">Working out your price…</p>`;
  const token = ++priceToken;
  setTimeout(() => {
    if (token !== priceToken) return;
    try {
      const q = quote();
      const { material: m, thickness: t, cheapest, board, extras, total, fixed: fp } = q;
      if (!cheapest) {
        el.innerHTML = `<p class="price-note">This one is bigger than our standard sheets, so we'll send you a price by email.</p>`;
        return;
      }
      lastPrice = { total, board, extras, sheets: `${cheapest.sheets} × ${cheapest.w} × ${cheapest.h} ${cheapest.code}` };
      el.innerHTML =
        `<p class="price-total">${money(total)} <small>for ${fp ? `${copiesLabel(fp)}, ` : ""}${escapeHtml(m.name.replace(/ \(.*\)$/, ""))}, ${t.mm} mm</small></p>` +
        (extras.length || (fp && fp.qty > 1) || q.band || !fp
          ? `<ul><li><span>${fp ? `${copiesLabel(fp).replace(/^./, (c) => c.toUpperCase())}${fp.qty > 1 ? ` at ${money(fp.each)} each` : ""}` : q.band ? escapeHtml(q.band.label) : "Map board (priced individually)"}${q.atMinimum ? " (minimum price)" : ""}</span><span>${money(board)}</span></li>${extras.map(([txt, v]) => `<li><span>${txt}</span><span>${money(v)}</span></li>`).join("")}</ul>`
          : "") +
        ((ETSY ? PRICING.etsyNote : PRICING.note) ? `<p class="price-note">${escapeHtml(ETSY ? PRICING.etsyNote : PRICING.note)}</p>` : "") +
        (ownerOnly ? `<p class="price-note"><b>Owner only:</b> customers don't see the price just now (pricing.showToCustomers in config.js).</p>` : "");
    } catch (err) {
      console.error(err);
      el.innerHTML = `<p class="price-note">We couldn't work out a price just now. We'll include it when we reply.</p>`;
    }
  }, 30);
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

// ---------- Step 5: customer's own text ----------
// Each block is a draggable box on the map, drawn at the size it will be
// engraved, centred where it will go. The corner handle (or the slider in
// the panel) scales the text; a clear box shows as a solid patch.
var textMarkers = []; // var: the frame is laid out before this step's code runs
function wantedTexts() {
  return state.texts.filter((t) => t.text.trim()).length;
}
const pxPerMm = () => frameRect().w / state.w;
function sizeTextMarker(i) {
  const t = state.texts[i], el = textMarkers[i]?.getElement();
  if (!el) return;
  const k = pxPerMm();
  const body = el.querySelector(".text-body");
  body.style.fontSize = `${Math.max(4, t.size * k)}px`;
  body.style.padding = t.clear ? `${TEXT_PAD_MM * k}px` : "1px 3px";
  body.classList.toggle("clear", t.clear);
}
function sizeTextMarkers() {
  state.texts.forEach((_, i) => sizeTextMarker(i));
}
function setTextSize(i, size) {
  state.texts[i].size = textSize(size);
  sizeTextMarker(i);
  const row = document.querySelector(`.text-row[data-i="${i}"]`);
  if (row) {
    row.querySelector(".text-size").value = state.texts[i].size;
    row.querySelector(".text-size-out").textContent = `${state.texts[i].size} mm`;
  }
}
// Drag the corner handle away from the centre to grow the text, towards it
// to shrink. The handle captures the pointer, so the drag keeps going even
// when the finger or mouse leaves it, and the map and marker never see it.
function startResize(i, e, handle) {
  e.stopPropagation();
  e.preventDefault();
  try { handle.setPointerCapture(e.pointerId); } catch {}
  const body = textMarkers[i].getElement().querySelector(".text-body").getBoundingClientRect();
  const cx = body.left + body.width / 2, cy = body.top + body.height / 2;
  const d0 = Math.max(12, Math.hypot(e.clientX - cx, e.clientY - cy)), s0 = state.texts[i].size;
  handle.classList.add("active");
  const move = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setTextSize(i, (s0 * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / d0);
  };
  const end = () => {
    handle.classList.remove("active");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
function refreshTextMarkers() {
  textMarkers.splice(0).forEach((m) => m.remove());
  state.texts.forEach((t, i) => {
    // The text sits in its own span so the grip below it doesn't move the centre.
    const el = document.createElement("div");
    el.className = "text-marker";
    el.innerHTML =
      '<span class="text-body"><span class="text-words"></span><span class="text-resize" title="Drag to resize" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 18L18 6M18 6h-6M18 6v6M6 18h6M6 18v-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></span></span><span class="text-grip" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>';
    el.querySelector(".text-words").textContent = t.text;
    el.title = "Drag to move";
    const handle = el.querySelector(".text-resize");
    handle.addEventListener("pointerdown", (e) => startResize(i, e, handle));
    // Keep the marker (and the map) from starting a drag of their own.
    for (const type of ["mousedown", "touchstart", "touchmove", "click", "dblclick"])
      handle.addEventListener(type, (e) => e.stopPropagation(), { passive: false });
    const marker = new maplibregl.Marker({ element: el, anchor: "center", draggable: true }).setLngLat([t.lng, t.lat]).addTo(map);
    marker.on("dragend", () => Object.assign(state.texts[i], marker.getLngLat()));
    textMarkers[i] = marker;
  });
  sizeTextMarkers();
}
function renderTexts() {
  $("#texts").innerHTML = state.texts
    .map(
      (t, i) => `
      <div class="place text-row" data-i="${i}">
        <div class="place-head"><span>Text ${i + 1}</span><button type="button" class="link-btn remove-text">Remove</button></div>
        <textarea class="text-input" rows="2" maxlength="${TEXT_MAX_CHARS}" placeholder="e.g. Our first Wainwright&#10;12 June 2025" aria-label="Text ${i + 1}">${escapeHtml(t.text)}</textarea>
        <label class="text-size-row"><span>Size</span>
          <input class="text-size" type="range" min="${TEXT_MIN_MM}" max="${TEXT_MAX_MM}" step="0.5" value="${t.size}" aria-label="Text ${i + 1} size">
          <output class="text-size-out">${t.size} mm</output></label>
        <label class="check"><input type="checkbox" class="text-clear" ${t.clear ? "checked" : ""}> Clear box behind the text</label>
        <p class="field-note text-clear-note">Nothing shows behind the words. On layered boards the layers are cut away so the text sits flat.</p>
      </div>`
    )
    .join("");
  $("#add-text").hidden = state.texts.length >= MAX_TEXTS;
  refreshTextMarkers();
}
$("#add-text").addEventListener("click", () => {
  if (state.texts.length >= MAX_TEXTS) return;
  const r = frameRect(), n = state.texts.length;
  const at = map.unproject([r.x + r.w / 2, r.y + r.h * (0.2 + n * 0.3)]);
  state.texts.push({ lng: at.lng, lat: at.lat, text: "", size: state.fontMm, clear: true });
  renderTexts();
  $(`.text-row[data-i="${n}"] .text-input`)?.focus();
});
$("#texts").addEventListener("click", (e) => {
  if (!e.target.closest(".remove-text")) return;
  state.texts.splice(+e.target.closest(".text-row").dataset.i, 1);
  renderTexts();
});
$("#texts").addEventListener("input", (e) => {
  const i = +e.target.closest(".text-row")?.dataset.i;
  if (e.target.classList.contains("text-size")) return setTextSize(i, +e.target.value);
  if (e.target.classList.contains("text-clear")) {
    state.texts[i].clear = e.target.checked;
    return sizeTextMarker(i);
  }
  if (!e.target.classList.contains("text-input")) return;
  const clean = cleanText(e.target.value);
  if (clean !== e.target.value) e.target.value = clean; // at most 4 lines
  state.texts[i].text = clean;
  textMarkers[i].getElement().querySelector(".text-words").textContent = clean;
});
renderTexts();

// ---------- Step 6: hiking route ----------
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

// ---------- Drawing a custom board shape ----------
let shapeDrawing = false;
let shapeDraft = [];
$("#shape-size").innerHTML = SHAPE_SIZES.map((mm) => `<option value="${mm}">${mm / 10} cm</option>`).join("");
$("#shape-size").value = String(customShape?.maxMm || 300);

function updateShapeDraft() {
  const features = shapeDraft.map((c, i) => ({ type: "Feature", properties: { first: i === 0 && shapeDraft.length >= 3 }, geometry: { type: "Point", coordinates: c } }));
  if (shapeDraft.length >= 3) features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...shapeDraft, shapeDraft[0]]] } });
  else if (shapeDraft.length === 2) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: shapeDraft } });
  onStyleReady(() => map.getSource("shape-draft").setData({ type: "FeatureCollection", features }));
  $("#shape-points").textContent = shapeDraft.length ? `${shapeDraft.length} point${shapeDraft.length > 1 ? "s" : ""}` : "";
}
function setShapeStatus(msg, kind = "") {
  $("#shape-status").textContent = msg;
  $("#shape-status").className = `status ${kind}`;
}
function startShapeDrawing() {
  if (drawing) stopDrawing(false);
  shapeDrawing = true;
  shapeDraft = [];
  updateShapeDraft();
  setMapLocked(false);
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = "crosshair";
  frameEl.classList.add("drawing-shape");
  $("#shape-panel").hidden = false;
  $("#shape-row").hidden = false;
  setShapeStatus("");
}
function stopShapeDrawing(keep) {
  shapeDrawing = false;
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = "";
  frameEl.classList.remove("drawing-shape");
  $("#shape-panel").hidden = true;
  const ring = shapeDraft;
  shapeDraft = [];
  updateShapeDraft();
  if (keep) {
    if (ring.length < 3) setShapeStatus("A shape needs at least three points.", "error");
    else applyShape(ring, +$("#shape-size").value);
  }
  $("#shape-row").hidden = state.template !== "custom";
}
// Make the drawn shape the board: its outline, size, and exactly its area of map.
function applyShape(ring, maxMm) {
  const c = customTemplateFrom(ring, maxMm);
  if (!c || c.tooThin) {
    setShapeStatus(c?.tooThin ? "That shape is too thin to cut at this size. Draw a wider shape or pick a bigger size." : "Couldn't use that shape. Please draw it again.", "error");
    return;
  }
  customShape = { ...c, maxMm };
  templates.custom = c.template;
  Object.assign(sizeOf("custom"), { w: c.template.w, h: c.template.h });
  setSize(c.template.w, c.template.h, "custom");
  $("#shape-row").hidden = false;
  const { west, south, east, north } = c.bounds;
  fitFrameTo([west, south, east, north]);
  pinnedBounds = { ...c.bounds }; // exactly the drawn area, until the map is moved by hand
  setMapLocked(true); // keep the drawn area in place
  setShapeStatus(`Your board: ${Math.round(c.template.w)} × ${Math.round(c.template.h)} mm. The map is locked so the area stays put.`, "ok");
}
map.on("click", (e) => {
  if (!shapeDrawing) return;
  // Clicking the first point closes the shape.
  if (shapeDraft.length >= 3) {
    const first = map.project(shapeDraft[0]);
    if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) return stopShapeDrawing(true);
  }
  shapeDraft.push([e.lngLat.lng, e.lngLat.lat]);
  updateShapeDraft();
});
map.on("dblclick", () => shapeDrawing && stopShapeDrawing(true));
document.addEventListener("keydown", (e) => {
  if (!shapeDrawing) return;
  if (e.key === "Enter") stopShapeDrawing(true);
  if (e.key === "Escape") stopShapeDrawing(false);
});
$("#shape-undo").addEventListener("click", () => {
  shapeDraft.pop();
  updateShapeDraft();
});
$("#shape-done").addEventListener("click", () => stopShapeDrawing(true));
$("#shape-cancel").addEventListener("click", () => stopShapeDrawing(false));
$("#shape-redraw").addEventListener("click", startShapeDrawing);
$("#shape-size").addEventListener("change", (e) => {
  if (shapeDrawing || !customShape) return; // used when the shape is finished
  applyShape(customShape.ring, +e.target.value);
});
$("#shape-row").hidden = state.template !== "custom";
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
  // Lake and wide-river areas too: they are filled in by the laser.
  const all = await fetchWater(bounds, [...kinds, ...(kinds.includes("lakes") ? ["lakefill"] : []), ...(kinds.includes("rivers") ? ["riverfill"] : [])]);
  return Object.fromEntries(Object.keys(all).map((k) => [k, all[k]]));
}

const WATER_MAX_METRES = 40000;
// Layouts covering more 0.1° data tiles than this leave out water and roads
// (about 200 km across).
const DETAIL_MAX_TILES = 600;
function detailTiles(b) {
  return (Math.floor(b.east / 0.1) - Math.floor(b.west / 0.1) + 1) * (Math.floor(b.north / 0.1) - Math.floor(b.south / 0.1) + 1);
}
let waterTimer, waterCall = 0;

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
  const call = ++waterCall; // a later call (the map moved again) wins
  if (groundWidthMetres(view) > WATER_MAX_METRES) {
    // Zoomed out: the simplified coastline only (rivers would be a tangle).
    map.getSource("water").setData(empty);
    note.textContent = "Zoom in to see rivers and lakes on the map.";
    if (!state.water.has("coast")) return;
    try {
      const { coast } = await fetchCoastOverview();
      if (call !== waterCall) return;
      map.getSource("water").setData({
        type: "FeatureCollection",
        features: coast.map((l) => ({ type: "Feature", properties: { kind: "coast" }, geometry: { type: "LineString", coordinates: l } })),
      });
    } catch {}
    return;
  }
  note.textContent = "Loading rivers and lakes…";
  try {
    const water = await waterFor(view);
    if (call !== waterCall) return;
    const features = Object.entries(water).filter(([kind]) => !kind.endsWith("fill")).flatMap(([kind, lines]) =>
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

// ---------- Etsy mode: which listing and options to choose ----------
// Worked out from the design (see CONFIG.etsy.guide), so the customer buys
// exactly what they designed.
function etsyChoice() {
  const g = CONFIG.etsy?.guide;
  if (!g || !lastResult) return null;
  const m = lastResult.meta;
  const size = CONFIG.sizes.find((s) => s.id === lastResult.sizeId);
  const product = g.products.find((p) => p.sizes.includes(lastResult.sizeId));
  if (!size || !product) return null;
  const layered = m.style !== "engraved";
  const band = layered ? g.layerBands.find((b) => m.layers <= b.upTo) : null;
  const extras = [];
  const add = (key, n) => n > 0 && g.extras[key] && extras.push([g.extras[key], n]);
  add("places", lastResult.places.length);
  add("texts", lastResult.texts.length);
  add("route", lastResult.routeOnBoard ? 1 : 0);
  add("frame", m.frameMm ? 1 : 0);
  // The order line pasted into Etsy, in plain words, e.g.
  // "A4 portrait | 16–25 layers | 2 special places".
  const qty = fixedProduct()?.qty || 1;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const extraWords = [
    lastResult.places.length && plural(lastResult.places.length, "special place", "special places"),
    lastResult.texts.length && plural(lastResult.texts.length, "text box", "text boxes"),
    lastResult.routeOnBoard && "Hiking route",
    m.frameMm && "Frame",
  ].filter(Boolean);
  const sizeWords = lastResult.sizeId === "custom" ? "Custom shape" : size.label.replace(/ \(.*\)$/, "");
  const optionWords = layered ? (band ? band.label : `${m.layers} layers – message us`) : qty > 1 ? `Set of ${qty}` : "Engraved";
  const tag = [sizeWords, optionWords, ...extraWords].join(" | ");
  return {
    tag,
    listing: product[layered ? "layered" : "engraved"],
    options: [["Size", size.label], ...(layered ? [["Layers", band ? band.label : null]] : []), ...(fixedProduct()?.maxQty > 1 ? [["Quantity", String(fixedProduct().qty)]] : [])],
    tooManyLayers: layered && !band ? m.layers : 0,
    extrasListing: g.extrasListing,
    extras,
  };
}
const etsyChoiceText = (c) =>
  `${c.listing} (${c.options.map(([k, v]) => `${k}: ${v ?? "message us"}`).join(", ")})` +
  (c.extras.length ? ` + ${c.extrasListing}: ${c.extras.map(([n, q]) => `${n} x${q}`).join(", ")}` : "");
function renderEtsyGuide() {
  const el = $("#etsy-guide");
  const c = ETSY ? etsyChoice() : null;
  el.hidden = !c;
  if (!c) return;
  const pill = (t) => `<span class="opt">${escapeHtml(t)}</span>`;
  el.innerHTML =
    `<h4>What to choose on Etsy</h4><ol>` +
    `<li>Listing <b>${escapeHtml(c.listing)}</b>: ${c.options.filter(([, v]) => v).map(([k, v]) => pill(`${k}: ${v}`)).join("")}</li>` +
    (c.extras.length
      ? `<li>Also add <b>${escapeHtml(c.extrasListing)}</b> to your basket, one for each: ${c.extras.map(([n, q]) => pill(`${n} × ${q}`)).join("")}</li>`
      : "") +
    `<li>Paste your design code into the personalisation box.</li></ol>` +
    `<p class="etsy-check">Please choose exactly these options. We check every order against its design before making anything.</p>` +
    (c.tooManyLayers
      ? `<p class="warn">Your design has ${c.tooManyLayers} layers, more than our listings cover. Please message us on Etsy before buying, or choose a bigger contour spacing.</p>`
      : "");
}

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
  // The line to paste into Etsy: the reference plus the options it needs, in words.
  const tag = etsyChoice()?.tag;
  const ref = tag ? `${lastResult.ref} | ${tag}` : lastResult.ref;
  btn.disabled = true;
  status.className = "status";
  let saved = false;
  // With a form service, the design is emailed to the shop under its code,
  // so the short code is all the customer needs to paste into Etsy.
  if (CONFIG.web3formsKey || CONFIG.formEndpoint) {
    status.textContent = "Saving your design…";
    const message =
      `${summary}\n\nEtsy mode: the customer will order and pay on Etsy, quoting ${ref}.` +
      (tag ? `\nThe Etsy order should be for: ${tag}. Check it has these options.` : "");
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
  $("#etsy-code").textContent = lastResult.ref;
  $("#etsy-order").textContent = tag || "";
  $("#etsy-copy").textContent = saved ? "Copy code" : "Copy code and design link";
  $("#etsy-help").textContent = saved
    ? "Paste this code into the personalisation box when you buy on Etsy, with the options shown above. We have your design saved under it."
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

// A link to a design (from a request email, an Etsy saved-design email or
// "Copy share link") opens the layout straight away, not just the map.
if (params.has("ref") && state.sharedBounds) {
  onStyleReady(() => setTimeout(() => $("#generate").click(), 400));
}

// ---------- Phones: the steps as swipeable cards under the map ----------
// On narrow screens (see style.css) the steps sit side by side in a strip you
// swipe through, with tabs above, so the map stays in view while you change
// options. On bigger screens the tabs are hidden and the steps stack as usual.
{
  const strip = $(".steps");
  const tabs = $("#step-tabs");
  const shown = () => [...strip.children].filter((li) => !li.hidden);
  const name = (li) => li.querySelector("h2").cloneNode(true);
  const renderTabs = () => {
    const steps = shown();
    tabs.innerHTML = "";
    steps.forEach((li, i) => {
      const h = name(li);
      h.querySelector(".optional")?.remove();
      const b = document.createElement("button");
      b.type = "button";
      b.className = "step-tab";
      b.innerHTML = `<span class="num">${i + 1}</span> ${escapeHtml(h.textContent.replace(/^\s*\d+\s*/, "").trim())}`;
      b.addEventListener("click", () => strip.scrollTo({ left: li.offsetLeft, behavior: "smooth" }));
      tabs.append(b);
    });
    markTab();
  };
  const markTab = () => {
    const steps = shown();
    const i = Math.min(steps.length - 1, Math.max(0, Math.round(strip.scrollLeft / (strip.clientWidth || 1))));
    [...tabs.children].forEach((b, j) => {
      const on = j === i;
      if (on && !b.hasAttribute("aria-current")) tabs.scrollTo({ left: b.offsetLeft - (tabs.clientWidth - b.offsetWidth) / 2, behavior: "smooth" });
      if (on) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
  };
  let raf = 0;
  strip.addEventListener("scroll", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(markTab);
  }, { passive: true });
  renderTabs();
  // Steps can be hidden or shown later (e.g. on other worlds): keep the tabs in step.
  new MutationObserver(renderTabs).observe(strip, { subtree: false, childList: true, attributes: true, attributeFilter: ["hidden"] });
  // The credits sit at the foot of the last card on phones (the page doesn't scroll there).
  const credits = document.createElement("div");
  credits.className = "phone-credits";
  credits.innerHTML = $(".site-footer").innerHTML;
  strip.lastElementChild.append(credits);
}
