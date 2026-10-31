// Interactive 3D preview of a layout: each contour layer extruded to the real
// material thickness and stacked, with engraved labels and a ruler for scale.
// All model units are millimetres.

import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";

// Material looks, keyed by the order form's material names.
const FINISHES = {
  "Birch plywood": { top: "#ead7b2", edge: "#80532f", grain: "#d9c095", roughness: 0.85 },
  "Oak veneer MDF": { top: "#c99a62", edge: "#3f2a1c", grain: "#b07f48", roughness: 0.8 },
  "Coloured acrylic": { ramp: ["#1d4e6e", "#3f8a8c", "#9cc5a1", "#efe2c8"], roughness: 0.25 },
};
const DEFAULT_FINISH = "Birch plywood";
const ENGRAVE = "#3a2414";

function grainTexture(base, grain) {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = grain;
  // Loose, wavy streaks read as wood grain without an image file.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const y0 = rnd() * 512, amp = 2 + rnd() * 6, f = 0.004 + rnd() * 0.01;
    g.globalAlpha = 0.12 + rnd() * 0.22;
    g.lineWidth = 0.6 + rnd() * 2.2;
    g.beginPath();
    for (let x = 0; x <= 512; x += 8) g.lineTo(x, y0 + Math.sin(x * f + i) * amp);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Flat text decal with the peak marker, positioned like the SVG label.
function labelMesh(text, fontMm, rightOfMarker) {
  const pxPerMm = 24;
  const font = `600 ${fontMm * pxPerMm}px Arial, Helvetica, sans-serif`;
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  g.font = font;
  const m = fontMm * 0.45 * pxPerMm; // marker half-size, matches layout.js
  const gap = m * 0.8;
  const textW = g.measureText(text).width;
  c.width = Math.ceil(textW + m * 2 + gap + 8);
  c.height = Math.ceil(fontMm * pxPerMm * 1.5);
  g.font = font;
  g.fillStyle = ENGRAVE;
  g.textBaseline = "middle";
  const cy = c.height / 2;
  const mx = rightOfMarker ? m + 4 : c.width - m - 4;
  g.beginPath();
  g.moveTo(mx - m, cy + m * 0.8);
  g.lineTo(mx, cy - m);
  g.lineTo(mx + m, cy + m * 0.8);
  g.fill();
  g.textAlign = rightOfMarker ? "left" : "right";
  g.fillText(text, rightOfMarker ? mx + m + gap : mx - m - gap, cy);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const w = c.width / pxPerMm, h = c.height / pxPerMm;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.rotation.x = -Math.PI / 2;
  // Shift so the marker, not the plane centre, sits on the peak.
  const markerX = (rightOfMarker ? m + 4 : c.width - m - 4) / pxPerMm;
  mesh.userData.offsetX = w / 2 - markerX;
  return mesh;
}

// Flat ruler along the front edge: mm ticks, numbered every centimetre band.
function rulerMesh(lengthMm) {
  const pxPerMm = 8, depthMm = 14;
  const c = document.createElement("canvas");
  c.width = Math.ceil(lengthMm * pxPerMm);
  c.height = depthMm * pxPerMm;
  const g = c.getContext("2d");
  g.fillStyle = "#f6efe2";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#2e2723";
  const step = lengthMm > 300 ? 5 : 1; // mm between ticks
  const labelEvery = lengthMm > 300 ? 50 : 10;
  for (let mm = 0; mm <= lengthMm; mm += step) {
    const major = mm % labelEvery === 0, mid = mm % (labelEvery / 2) === 0;
    const len = major ? 6 : mid ? 4 : 2.2;
    g.fillRect(Math.min(mm * pxPerMm, c.width - 2), 0, mm % 10 === 0 ? 2 : 1, len * pxPerMm);
    if (major) {
      g.font = `600 ${4.2 * pxPerMm}px Arial, sans-serif`;
      g.textAlign = mm === 0 ? "left" : mm >= lengthMm - 1 ? "right" : "center";
      g.fillText(`${mm / 10}`, mm * pxPerMm, 11 * pxPerMm);
    }
  }
  g.textAlign = "right";
  g.font = `${3.2 * pxPerMm}px Arial, sans-serif`;
  g.fillText("cm", c.width - 2, 13.4 * pxPerMm);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const geo = new THREE.BoxGeometry(lengthMm, 1, depthMm);
  const plain = new THREE.MeshStandardMaterial({ color: "#e9dfcd", roughness: 0.6 });
  const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
  // BoxGeometry material order: +x, -x, +y (top), -y, +z, -z
  const mesh = new THREE.Mesh(geo, [plain, plain, top, plain, plain, plain]);
  mesh.receiveShadow = true;
  return { mesh, depthMm };
}

function rampColour(stops, t) {
  const cols = stops.map((s) => new THREE.Color(s));
  const x = Math.min(0.9999, Math.max(0, t)) * (cols.length - 1);
  const i = Math.floor(x);
  return cols[i].clone().lerp(cols[i + 1], x - i);
}

function shapesFor(polys, W, H) {
  const pt = ([x, y]) => new THREE.Vector2(x - W / 2, H / 2 - y);
  return polys.map(([outer, ...holes]) => {
    const shape = new THREE.Shape(outer.map(pt));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map(pt)));
    return shape;
  });
}

export function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47; // never look from under the table
  controls.screenSpacePanning = true;

  scene.add(new THREE.HemisphereLight("#fffaf0", "#8a7a66", 1.4));
  const sun = new THREE.DirectionalLight("#fff4e0", 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const model = new THREE.Group();
  scene.add(model);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  let running = false;
  const loop = () => {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);

  function clear() {
    model.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) {
        m.map?.dispose();
        m.dispose();
      }
    });
    model.clear();
  }

  /**
   * @param {object} result  buildLayout() result
   * @param {{thickness:number, material:string}} opts
   */
  function show(result, opts) {
    clear();
    const { widthMm: W, heightMm: H, style, interval } = result.meta;
    const t = opts.thickness;
    const finish = FINISHES[opts.material] || FINISHES[DEFAULT_FINISH];
    const layers = style === "engraved" ? result.layers.slice(0, 1) : result.layers;
    const boardT = style === "engraved" ? Math.max(t, 6) : t;
    const n = layers.length;

    let grain = null;
    if (!finish.ramp) {
      grain = grainTexture(finish.top, finish.grain);
      grain.repeat.set(1 / 160, 1 / 160);
    }

    layers.forEach((layer, i) => {
      const geo = new THREE.ExtrudeGeometry(shapesFor(layer.polys, W, H), { depth: boardT, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      let cap, side;
      if (finish.ramp) {
        const col = rampColour(finish.ramp, n > 1 ? i / (n - 1) : 0);
        cap = new THREE.MeshStandardMaterial({ color: col, roughness: finish.roughness });
        side = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.8), roughness: finish.roughness });
      } else {
        // Vary each sheet slightly so the stack doesn't look like one block.
        const tint = new THREE.Color(1, 1, 1).multiplyScalar(0.94 + ((i * 37) % 11) / 100);
        cap = new THREE.MeshStandardMaterial({ map: grain, color: tint, roughness: finish.roughness });
        side = new THREE.MeshStandardMaterial({ color: finish.edge, roughness: 0.95 });
      }
      if (style === "engraved") cap = new THREE.MeshStandardMaterial({ map: engravedTexture(result, finish), roughness: finish.roughness ?? 0.8 });
      const mesh = new THREE.Mesh(geo, [cap, side]);
      mesh.position.y = i * boardT;
      mesh.castShadow = mesh.receiveShadow = true;
      model.add(mesh);
    });

    for (const l of result.labels) {
      const layer = style === "engraved" ? 0 : l.layer;
      const fontMm = result.meta.fontMm || 3.5;
      const right = l.x < W * 0.72;
      const mesh = labelMesh(l.text, fontMm, right);
      mesh.position.set(l.x - W / 2 + mesh.userData.offsetX, (layer + 1) * boardT + 0.05, l.y - H / 2);
      model.add(mesh);
    }

    const { mesh: ruler, depthMm } = rulerMesh(W);
    ruler.position.set(0, 0.5, H / 2 + depthMm / 2 + 8);
    model.add(ruler);

    // Lights, ground and camera sized to the piece.
    const span = Math.max(W, H);
    const stackH = n * boardT;
    sun.position.set(-span * 0.6, span * 1.2, span * 0.8);
    sun.target.position.set(0, 0, 0);
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 4 });
    sun.shadow.camera.updateProjectionMatrix();
    ground.scale.set(span * 4, span * 4, 1);

    // Aim a little towards the front so the ruler is in shot.
    controls.target.set(0, stackH / 3, span * 0.08);
    camera.position.set(span * 0.12, span * 1.2 + stackH, span * 1.6);
    controls.minDistance = span * 0.25;
    controls.maxDistance = span * 4;
    controls.update();

    resize();
    if (!running) {
      running = true;
      loop();
    }
    return { stackHeightMm: stackH, layers: n, interval };
  }

  function engravedTexture(result, finish) {
    const { widthMm: W, heightMm: H } = result.meta;
    const k = Math.min(6, 2048 / Math.max(W, H));
    const c = document.createElement("canvas");
    c.width = Math.round(W * k);
    c.height = Math.round(H * k);
    const g = c.getContext("2d");
    const base = grainTexture(finish.top || "#ead7b2", finish.grain || "#d9c095").image;
    g.fillStyle = g.createPattern(base, "repeat");
    g.fillRect(0, 0, c.width, c.height);
    g.scale(k, k);
    g.strokeStyle = ENGRAVE;
    g.globalAlpha = 0.75;
    g.lineWidth = 0.35;
    for (const l of result.layers.slice(1)) g.stroke(new Path2D(l.d));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // Extrude UVs are shape coordinates in mm, centred on the board.
    tex.repeat.set(1 / W, 1 / H);
    tex.offset.set(0.5, 0.5);
    return tex;
  }

  return {
    show,
    stop() {
      running = false;
    },
  };
}
