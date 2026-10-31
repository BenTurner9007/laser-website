/* global maplibregl, mlcontour */
import { CONFIG, REGIONS, HILL_LISTS } from "./config.js";
import { buildLayout, DEM_URL } from "./layout.js";
import { createViewer } from "./viewer3d.js";

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
  lists: params.has("lists") ? new Set(params.get("lists").split(",").filter(Boolean)) : new Set(HILL_LISTS.filter((l) => l.on).map((l) => l.id)),
  osm: params.get("osm") === "1",
  sharedBounds: params.get("b") ? params.get("b").split(",").map(Number) : null,
  thickness: +params.get("t") || CONFIG.thicknesses[0],
  material: params.get("mat") || "",
};
// A shared link's exact area is used for the layout until the map is moved by hand.
let pinnedBounds = null;
let osmPeaks = [];
let lastResult = null;

// ---------- Branding ----------
document.title = `${CONFIG.businessName} – Contour Map Designer`;
$("#brand-name").textContent = CONFIG.businessName;
$("#brand-tagline").textContent = CONFIG.tagline;

// ---------- Map ----------
const demSource = new mlcontour.DemSource({ url: DEM_URL, encoding: "terrarium", maxzoom: 13, worker: true });
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
  center: [-3.1, 54.48],
  zoom: 10.6,
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: { compact: true },
  style: {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© OpenStreetMap contributors",
      },
      dem: {
        type: "raster-dem",
        encoding: "terrarium",
        tiles: [demSource.sharedDemProtocolUrl],
        tileSize: 256,
        maxzoom: 13,
        attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen / AWS</a>',
      },
      contours: { type: "vector", tiles: [contourTiles(state.interval)], maxzoom: 15 },
      hills: {
        type: "geojson",
        data: "data/hills.geojson",
        attribution: '<a href="https://www.hill-bagging.co.uk/dobih">DoBIH v18.6</a> CC BY 4.0',
      },
      // Same data again without labels, so the dots still draw if label fonts fail to load.
      "hills-pts": { type: "geojson", data: "data/hills.geojson" },
      osmpeaks: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      { id: "paper", type: "background", paint: { "background-color": "#efe2c8" } },
      { id: "osm", type: "raster", source: "osm", layout: { visibility: "none" }, paint: { "raster-opacity": 0.55, "raster-saturation": -0.6 } },
      {
        id: "hillshade",
        type: "hillshade",
        source: "dem",
        paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#4a3d34", "hillshade-highlight-color": "#fbf7f0" },
      },
      {
        id: "contour-lines",
        type: "line",
        source: "contours",
        "source-layer": "contours",
        paint: { "line-color": "#6e6457", "line-opacity": ["match", ["get", "level"], 1, 0.85, 0.45], "line-width": ["match", ["get", "level"], 1, 1.3, 0.6] },
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
      {
        id: "osmpeaks-dots",
        type: "circle",
        source: "osmpeaks",
        paint: { "circle-radius": 3, "circle-color": "#8a8173", "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
      },
      {
        id: "osmpeaks-labels",
        type: "symbol",
        source: "osmpeaks",
        layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": 11, "text-offset": [0, 0.9], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": "#4b443b", "text-halo-color": "#fff", "text-halo-width": 1.2 },
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
    ],
  },
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

// Street map toggle
const toggle = document.createElement("label");
toggle.className = "map-toggle";
toggle.innerHTML = '<input type="checkbox" id="show-osm"> Street map';
$(".map-wrap").appendChild(toggle);
$("#show-osm").addEventListener("change", (e) => map.setLayoutProperty("osm", "visibility", e.target.checked ? "visible" : "none"));

// Hill popups
map.on("click", "hills-dots", (e) => {
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
  $("#frame-size").textContent = `${state.w} × ${state.h} mm`;
  updateScale();
}

function frameBounds() {
  const r = frameRect();
  const nw = map.unproject([r.x, r.y]);
  const se = map.unproject([r.x + r.w, r.y + r.h]);
  return { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
}

function groundWidthMetres(b) {
  const lat = ((b.north + b.south) / 2) * (Math.PI / 180);
  return (b.east - b.west) * (Math.PI / 180) * 6371008 * Math.cos(lat);
}

function updateScale() {
  const b = frameBounds();
  const metres = groundWidthMetres(b);
  const scale = metres / (state.w / 1000);
  const km = metres / 1000;
  $("#frame-scale").textContent = `${km < 10 ? km.toFixed(1) : Math.round(km)} km across · 1:${(Math.round(scale / 100) * 100).toLocaleString("en-GB")}`;
}

function fitToSharedBounds() {
  const [w, s, e, n] = state.sharedBounds;
  const r = frameRect();
  map.fitBounds(
    [[w, s], [e, n]],
    { padding: { top: r.y, left: r.x, bottom: r.ch - r.y - r.h, right: r.cw - r.x - r.w }, duration: 0 }
  );
}

new ResizeObserver(layoutFrame).observe($(".map-wrap"));
map.on("move", updateScale);
map.on("movestart", (e) => {
  if (e.originalEvent) pinnedBounds = null;
});
// "load" waits for every tile; the style being ready is enough to position the map.
const onStyleReady = (fn) => (map.isStyleLoaded() ? fn() : map.once("style.load", fn));
onStyleReady(() => {
  layoutFrame();
  if (state.sharedBounds?.length === 4 && state.sharedBounds.every(Number.isFinite)) {
    fitToSharedBounds();
    const [west, south, east, north] = state.sharedBounds;
    pinnedBounds = { west, south, east, north };
  }
  if (state.osm) loadOsmPeaks();
});

// ---------- Step 1: search and regions ----------
let hillIndex = [];
fetch("data/hills.geojson")
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

$("#regions").innerHTML = REGIONS.map((r, i) => `<button type="button" class="chip" data-i="${i}">${r.label}</button>`).join("");
$("#regions").addEventListener("click", (e) => {
  const r = REGIONS[e.target.dataset.i];
  if (r) map.flyTo({ center: [r.at[0], r.at[1]], zoom: r.at[2] });
});

// ---------- Step 2: sizes ----------
function renderSizes() {
  $("#sizes").innerHTML = CONFIG.sizes
    .map((s) => {
      const on = s.w === state.w && s.h === state.h;
      return `<button type="button" class="chip" role="radio" aria-checked="${on}" data-id="${s.id}">${s.label}</button>`;
    })
    .join("");
  $("#size-w").value = state.w;
  $("#size-h").value = state.h;
}
$("#sizes").addEventListener("click", (e) => {
  const s = CONFIG.sizes.find((x) => x.id === e.target.dataset.id);
  if (!s) return;
  setSize(s.w, s.h);
});
for (const id of ["#size-w", "#size-h"]) {
  $(id).addEventListener("change", () => {
    const w = clamp(+$("#size-w").value || state.w, 50, 1000);
    const h = clamp(+$("#size-h").value || state.h, 50, 1000);
    setSize(w, h);
  });
}
function setSize(w, h) {
  state.w = w;
  state.h = h;
  renderSizes();
  layoutFrame();
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- Step 3: style ----------
document.querySelectorAll('input[name="style"]').forEach((el) => {
  el.checked = el.value === state.style;
  el.addEventListener("change", () => (state.style = el.value));
});
$("#interval").value = String(state.interval);
$("#interval").addEventListener("change", (e) => {
  state.interval = +e.target.value;
  map.getSource("contours").setTiles([contourTiles(state.interval)]);
});
$("#smoothing").value = String(state.smoothing);
$("#smoothing").addEventListener("change", (e) => (state.smoothing = +e.target.value));
$("#label-mode").value = state.labelMode;
$("#label-mode").addEventListener("change", (e) => (state.labelMode = e.target.value));
$("#font-mm").value = String(state.fontMm);
$("#font-mm").addEventListener("change", (e) => (state.fontMm = +e.target.value));

$("#lists").innerHTML = HILL_LISTS.map(
  (l) => `<label class="check"><input type="checkbox" value="${l.id}" ${state.lists.has(l.id) ? "checked" : ""}> ${l.label}</label>`
).join("");
$("#lists").addEventListener("change", (e) => {
  if (e.target.checked) state.lists.add(e.target.value);
  else state.lists.delete(e.target.value);
  const f = state.lists.size ? listFilter() : ["==", "id", -1];
  map.setFilter("hills-dots", f);
  map.setFilter("hills-labels", f);
});

$("#osm-peaks").checked = state.osm;
$("#osm-peaks").addEventListener("change", (e) => {
  state.osm = e.target.checked;
  if (state.osm) loadOsmPeaks();
  else {
    osmPeaks = [];
    map.getSource("osmpeaks").setData({ type: "FeatureCollection", features: [] });
  }
});
map.on("moveend", () => {
  if (state.osm) loadOsmPeaksDebounced();
});

let osmTimer;
function loadOsmPeaksDebounced() {
  clearTimeout(osmTimer);
  osmTimer = setTimeout(loadOsmPeaks, 800);
}

async function loadOsmPeaks() {
  const b = frameBounds();
  if (groundWidthMetres(b) > 60000) {
    setStatus("Zoom in a little to load extra OpenStreetMap peaks.");
    return;
  }
  const pad = 0.02;
  const q = `[out:json][timeout:20];node["natural"~"^(peak|hill)$"]["name"](${b.south - pad},${b.west - pad},${b.north + pad},${b.east + pad});out body;`;
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: q }) });
    if (!res.ok) throw new Error(res.status);
    const json = await res.json();
    osmPeaks = json.elements.map((n) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [n.lon, n.lat] },
      properties: { name: n.tags.name, h: Math.round(parseFloat(n.tags.ele)) || null },
    }));
    map.getSource("osmpeaks").setData({ type: "FeatureCollection", features: osmPeaks });
  } catch {
    setStatus("Couldn’t reach OpenStreetMap for extra peaks just now – the main hill lists still work.", "error");
  }
}

// ---------- Step 4: generate ----------
function setStatus(msg, kind = "") {
  const el = $("#status");
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function peaksInFrame(b) {
  const inside = ([lng, lat]) => lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;
  const peaks = hillIndex
    .filter((f) => inside(f.geometry.coordinates) && [...state.lists].some((id) => f.properties.lists.includes(`,${id},`)))
    .map((f) => ({ name: f.properties.name, h: f.properties.h, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
  if (state.osm) {
    // Skip OSM peaks already covered by a listed hill (within ~150 m).
    const near = (a, p) => Math.abs(a.lng - p.lng) < 0.0025 && Math.abs(a.lat - p.lat) < 0.0014;
    for (const f of osmPeaks) {
      const p = { name: f.properties.name, h: f.properties.h, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
      if (inside([p.lng, p.lat]) && !peaks.some((a) => near(a, p))) peaks.push(p);
    }
  }
  return peaks;
}

function shareLink(b) {
  const p = new URLSearchParams({
    b: [b.west, b.south, b.east, b.north].map((v) => v.toFixed(5)).join(","),
    w: state.w,
    h: state.h,
    ci: state.interval,
    sm: state.smoothing,
    style: state.style,
    labels: state.labelMode,
    font: state.fontMm,
    lists: [...state.lists].join(","),
    osm: state.osm ? "1" : "0",
    t: $("#thickness").value,
    mat: $("#material").value,
  });
  return `${location.origin}${location.pathname}?${p}`;
}

$("#generate").addEventListener("click", async () => {
  const btn = $("#generate");
  btn.disabled = true;
  const b = pinnedBounds || frameBounds();
  try {
    setStatus("Fetching elevation data…");
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
        guides: true,
      },
      (f) => setStatus(`Fetching elevation data… ${Math.round(f * 100)}%`)
    );
    lastResult = { ...result, bounds: b, link: shareLink(b), ref: makeRef() };
    showResult();
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong building the layout. Please try again.", "error");
  } finally {
    btn.disabled = false;
  }
});

const makeRef = () => "CM-" + Date.now().toString(36).toUpperCase().slice(-6);

function stackHeight() {
  return lastResult ? lastResult.meta.layers * +$("#thickness").value : 0;
}

function renderStats() {
  const m = lastResult.meta;
  const items = [
    ["Reference", lastResult.ref],
    ["Size", `${m.widthMm} × ${m.heightMm} mm`],
    ["Heights", `${m.minElevation}–${m.maxElevation} m`],
    [m.style === "layered" ? "Layers" : "Contour lines", m.style === "layered" ? m.layers : m.layers - 1],
    ["Named peaks", lastResult.peaksPlaced],
  ];
  if (m.style === "layered") items.push(["Stack height", `≈ ${stackHeight()} mm`]);
  let html = items.map(([k, v]) => `<li>${k}: <b>${escapeHtml(v)}</b></li>`).join("");
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
    viewer.show(lastResult, { thickness: +$("#thickness").value, material: $("#material").value });
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
      ? `<b>${m.widthMm} × ${m.heightMm} mm</b>, <b>${m.layers} layers × ${t} mm = ${m.layers * t} mm tall</b>. ` +
        `Map scale 1:${scale}. Each layer is ${m.interval} m of height, ${exaggeration(t)}. The ruler is in centimetres.`
      : `<b>${m.widthMm} × ${m.heightMm} mm</b> board. Map scale 1:${scale}, contours every ${m.interval} m. The ruler is in centimetres.`;
}

function selectTab(which) {
  const is3d = which === "3d";
  $("#tab-3d").setAttribute("aria-selected", is3d);
  $("#tab-plan").setAttribute("aria-selected", !is3d);
  $("#viewer").hidden = !is3d;
  $("#preview").hidden = is3d;
}
$("#tab-3d").addEventListener("click", () => selectTab("3d"));
$("#tab-plan").addEventListener("click", () => selectTab("plan"));
$("#result").addEventListener("close", () => viewer?.stop());

function showResult() {
  $("#preview").innerHTML = lastResult.preview;
  renderStats();
  $("#order-status").textContent = "";
  $("#result").showModal();
  if (!$("#tab-3d").hidden) selectTab("3d");
  render3d();
}

$("#thickness").innerHTML = CONFIG.thicknesses.map((t) => `<option value="${t}">${t} mm</option>`).join("");
if (CONFIG.thicknesses.includes(state.thickness)) $("#thickness").value = String(state.thickness);
if ([...$("#material").options].some((o) => o.value === state.material)) $("#material").value = state.material;
for (const id of ["#thickness", "#material"]) {
  $(id).addEventListener("change", () => {
    if (!lastResult) return;
    lastResult.link = shareLink(lastResult.bounds);
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
  const blob = new Blob([lastResult.svg], { type: "image/svg+xml" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `contour-layout-${lastResult.ref}.svg` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
    `Board: ${m.widthMm} x ${m.heightMm} mm, ${m.style === "layered" ? `${m.layers} layers at ${fd.thickness} mm (≈${stackHeight()} mm)` : "single engraved board"}`,
    `Contours every ${m.interval} m, smoothing ${m.smoothing}, heights ${m.minElevation}-${m.maxElevation} m`,
    `Material: ${fd.material}`,
    `Area (W,S,E,N): ${[m.bounds.west, m.bounds.south, m.bounds.east, m.bounds.north].map((v) => v.toFixed(5)).join(", ")}`,
    `Open the design: ${lastResult.link}`,
    "",
    `Notes: ${fd.notes || "-"}`,
  ].join("\n");
  const status = $("#order-status");

  if (CONFIG.formEndpoint) {
    status.textContent = "Sending…";
    status.className = "status";
    try {
      const res = await fetch(CONFIG.formEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name: fd.name, email: fd.email, _subject: `Contour map request ${lastResult.ref}`, message: summary }),
      });
      if (!res.ok) throw new Error(res.status);
      status.textContent = `Thanks ${fd.name}! We’ve got your layout (${lastResult.ref}) and will be in touch soon.`;
      status.className = "status ok";
    } catch {
      status.textContent = `Couldn’t send just now. Please copy the share link and email it to ${CONFIG.orderEmail}.`;
      status.className = "status error";
    }
    return;
  }

  const body = `Hi,\n\nI'd like a laser-cut contour map of this layout.\n\n${summary}\n\nName: ${fd.name}\nEmail: ${fd.email}\n`;
  location.href = `mailto:${CONFIG.orderEmail}?subject=${encodeURIComponent(`Contour map request ${lastResult.ref}`)}&body=${encodeURIComponent(body)}`;
  status.textContent = "Your email app should open with your layout link and details filled in – just press send.";
  status.className = "status ok";
});

renderSizes();
