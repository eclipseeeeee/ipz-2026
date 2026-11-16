import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { round2, hexToNum, colorHex, clampv } from './js/utils.js?v=2';
import { planDrywall } from './js/drywall.js?v=2';

// ---------- State ----------
// A room: interior box (width × length × height) centered at (x, z) in plan,
// floor at level `floor`; walls can have individual thicknesses.
function defaultRoom(seq = 1) {
  return {
    id: 'r-' + seq,
    name: `Кімната ${seq}`,
    x: 0, z: 0,          // world position of the room's plan center (m)
    width: 5,            // X
    length: 4,           // Z
    height: 2.7,         // Y
    floor: 0,            // floor level (m) — rooms may differ
    thickness: { north: 0.1, south: 0.1, east: 0.1, west: 0.1 },
  };
}

const state = {
  rooms: [defaultRoom(1)],
  activeRoom: 'r-1',   // room currently edited by the side forms
  showCeiling: false,
  gridStep: 0.5,      // grid/ruler step in meters
  showWallGrid: true, // draw measurement grid on walls
  showDoorLabels: false, // show object NAME labels
  showDims: false,       // show dimension labels on all objects
  showDoorRuler: false,  // show distances from room corners to doors
  showDrywall: false,    // overlay the drywall sheet layout on the model
  showLeftovers: true,   // lay leftover offcuts out beside the room
  useLeftovers: true,    // assemble least-used sheets from leftovers (saves sheets)
  dwOrient: 'auto',      // drywall orientation: auto / h / v
  dwStagger: true,       // brick-pattern staggered joints
  wallColor: 0x93c5fd,   // wall color (used when no wall image)
  wallOpaque: false,     // show wall color without transparency
  wallImage: null,       // wall background image (data URL) or null
  floorColor: 0x475569,  // floor color
  doors: [],
  elements: [],       // sockets, switches, electrical panels
  wires: [],          // wiring between electrical elements
  lights: [],         // ceiling lights {id, x, z}
  wallObjects: [],    // pictures / mirrors on walls
};

// Snapshot of the default (empty) state — used to start a fresh project.
const INITIAL = JSON.parse(JSON.stringify(state));

// Whether a project is open. Until then only the "Файл" tab is usable.
let hasProject = false;

// id of the door currently being edited (null = add mode)
let editingId = null;
// id of the electrical element currently being edited (null = add mode)
let editingElemId = null;
// id of the wall object currently being edited (null = add mode)
let editingObjId = null;

// Draft flags (item was created just by starting to fill the add form) and
// snapshots of the original item (for reverting edits on "Відхилити").
let isDraftDoor = false, snapDoor = null;
let isDraftElem = false, snapElem = null;
let isDraftObj = false, snapObj = null;

// Pending image data URLs for the door and wall-object forms (null = none).
let doorFormImage = null;
let objFormImage = null;

function readImageFile(file, cb) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => cb(reader.result);
  reader.readAsDataURL(file);
}

// Cache textures by data URL so rebuilds don't reload/leak them.
const textureCache = new Map();
function getTexture(url, key, configure) {
  if (!url) return null;
  const k = key || url;
  if (textureCache.has(k)) return textureCache.get(k);
  const tex = new THREE.TextureLoader().load(url, () => renderer.render(scene, camera));
  tex.colorSpace = THREE.SRGBColorSpace;
  if (configure) configure(tex);
  textureCache.set(k, tex);
  return tex;
}

// Electrical element metadata: label, color, on-wall size (w × h) in meters.
const elementTypes = {
  socket: { label: 'Розетка', color: 0x22c55e, size: [0.09, 0.09], gangs: 1 },
  socket2: { label: 'Розетка подвійна', color: 0x22c55e, size: [0.17, 0.09], gangs: 2 },
  socket3: { label: 'Розетка потрійна', color: 0x22c55e, size: [0.25, 0.09], gangs: 3 },
  switch: { label: 'Вимикач', color: 0xeab308, size: [0.09, 0.09], gangs: 1 },
  switch2: { label: 'Вимикач подвійний', color: 0xeab308, size: [0.09, 0.09], gangs: 2, keys: true },
  switch3: { label: 'Вимикач потрійний', color: 0xeab308, size: [0.09, 0.09], gangs: 3, keys: true },
  combo: { label: 'Комбінований (розетка+вимикач)', color: 0x22c55e, size: [0.09, 0.17], combo: true },
  wireout: { label: 'Вивід проводки', color: 0xa855f7, size: [0.05, 0.05] },
  panel: { label: 'Електрощиток', color: 0x9ca3af, size: [0.32, 0.5] },
  junction: { label: 'Розподільча коробка', color: 0xb45309, size: [0.1, 0.1] },
};

// Effective on-wall size of an element: per-element override (panels) or type default.
function elemSize(el) {
  const def = (elementTypes[el.type] || elementTypes.socket).size;
  const w = isFinite(el.w) && el.w > 0 ? el.w : def[0];
  const h = isFinite(el.h) && el.h > 0 ? el.h : def[1];
  return [w, h];
}

const wallNames = {
  north: 'Північна',
  south: 'Південна',
  east: 'Східна',
  west: 'Західна',
};

// Palette for door colors (cycled)
const doorColors = [0xff8c00, 0x8b4513, 0xff5722, 0xd2691e, 0xb8860b, 0xcd5c5c];
let doorSeq = 0;

// ---------- Three.js setup ----------
const canvas = document.getElementById('scene');
const canvasWrap = document.getElementById('canvas-wrap');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0b);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
dirLight.position.set(6, 10, 8);
scene.add(dirLight);

// Group holding everything that gets rebuilt
let roomGroup = new THREE.Group();
scene.add(roomGroup);

function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => m.dispose());
    }
  });
  group.clear();
}

// ---------- Room context ----------
// Geometry helpers work "in a room". R is the current room context; entry
// points (mesh builders, forms, per-room loops) set it via setRoomCtx before
// calling the shared helpers. When unset it falls back to the active room.
let R = null;
function roomById(id) {
  return state.rooms.find((r) => r.id === id) || state.rooms[0];
}
function activeRoom() {
  return roomById(state.activeRoom);
}
function roomOf(obj) {
  return roomById(obj && obj.room);
}
function setRoomCtx(room) {
  R = room || null;
}
function cur() {
  return R || activeRoom();
}
// The room whose interior (with a small margin) contains a world point.
function roomAtPoint(p, margin = 0.3) {
  for (const r of state.rooms) {
    if (Math.abs(p.x - r.x) <= r.width / 2 + margin &&
        Math.abs(p.z - r.z) <= r.length / 2 + margin &&
        p.y >= r.floor - margin && p.y <= r.floor + r.height + margin) return r;
  }
  return null;
}

// Wall length along its horizontal axis
function wallLength(wall) {
  const r = cur();
  // north/south run along X (width), east/west run along Z (length)
  return (wall === 'north' || wall === 'south') ? r.width : r.length;
}

function buildScene() {
  disposeGroup(roomGroup);

  const wallTex = getTexture(state.wallImage);
  const wallOpacity = wallTex ? 0.9 : (state.wallOpaque ? 1 : 0.28);

  state.rooms.forEach((room) => {
    setRoomCtx(room);
    const { width: w, length: l, height: h, floor: fy, x: cx, z: cz } = room;

    // Floor
    const floorGeo = new THREE.PlaneGeometry(w, l);
    const floorMat = new THREE.MeshStandardMaterial({
      color: state.floorColor,
      side: THREE.DoubleSide,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, fy, cz);
    floor.userData = { surface: 'floor' };
    roomGroup.add(floor);

    // Ceiling (optional)
    if (state.showCeiling) {
      const ceilGeo = new THREE.PlaneGeometry(w, l);
      const ceilMat = new THREE.MeshStandardMaterial({
        color: 0x64748b,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.35,
      });
      const ceil = new THREE.Mesh(ceilGeo, ceilMat);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set(cx, fy + h, cz);
      ceil.userData = { surface: 'ceiling' };
      roomGroup.add(ceil);
    }

    // Walls: boxes with real thickness growing outward from the interior face.
    const wallMat = new THREE.MeshStandardMaterial({
      color: wallTex ? 0xffffff : state.wallColor,
      map: wallTex,
      side: THREE.DoubleSide,
      transparent: wallOpacity < 1,
      opacity: wallOpacity,
    });
    const th = room.thickness || {};
    const t = (wall) => Math.max(0.01, th[wall] ?? 0.1);
    // north: +Z wall (spans X), south: -Z wall (spans X)
    // east:  -X wall (spans Z), west:  +X wall (spans Z)
    const walls = [
      { span: w, t: t('north'), px: cx, pz: cz + l / 2 + t('north') / 2, rotY: 0 },
      { span: w, t: t('south'), px: cx, pz: cz - l / 2 - t('south') / 2, rotY: 0 },
      { span: l, t: t('east'), px: cx - w / 2 - t('east') / 2, pz: cz, rotY: Math.PI / 2 },
      { span: l, t: t('west'), px: cx + w / 2 + t('west') / 2, pz: cz, rotY: Math.PI / 2 },
    ];
    walls.forEach((wd) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(wd.span, h, wd.t), wallMat.clone());
      mesh.position.set(wd.px, fy + h / 2, wd.pz);
      mesh.rotation.y = wd.rotY;
      roomGroup.add(mesh);
    });

    // Room name label above the room
    if (state.rooms.length > 1) {
      const lab = makeTextSprite(room.name || room.id, { scale: 0.5 });
      lab.position.set(cx, fy + h + 0.3, cz);
      roomGroup.add(lab);
    }
  });
  setRoomCtx(null);

  // Doors
  state.doors.forEach((door) => addDoorMesh(door));

  // Electrical elements
  state.elements.forEach((el) => addElementMesh(el));

  // Wiring between electrical elements
  state.wires.forEach((wire) => addWireMesh(wire));

  // Ceiling lights
  state.lights.forEach((light) => addLightMesh(light));

  // Wall objects (pictures / mirrors)
  state.wallObjects.forEach((obj) => addWallObjectMesh(obj));

  // Name / dimension labels for all objects
  addObjectLabels();

  // Drywall sheet layout overlay
  buildDrywallOverlay();

  // Measurement grid (ruler) with configurable step
  buildGrids();
}

// Build a set of grid lines (a "ruler") on the floor and, optionally, walls.
function buildGrids() {
  const step = state.gridStep > 0 ? state.gridStep : 0.5;
  state.rooms.forEach((room) => {
    const { width: w, length: l, height: h, floor: fy, x: cx, z: cz } = room;

    // Floor grid
    const floorGrid = makeGridLines(w, l, step, 0x64748b);
    floorGrid.rotation.x = -Math.PI / 2;
    floorGrid.position.set(cx, fy + 0.002, cz);
    roomGroup.add(floorGrid);

    if (!state.showWallGrid) return;

    const gc = 0x38bdf8; // wall grid color
    const eps = 0.006;
    const grids = [
      { u: w, v: h, pos: [cx, fy + h / 2, cz + l / 2 - eps], rotY: 0 },      // north
      { u: w, v: h, pos: [cx, fy + h / 2, cz - l / 2 + eps], rotY: 0 },     // south
      { u: l, v: h, pos: [cx - w / 2 + eps, fy + h / 2, cz], rotY: Math.PI / 2 }, // east
      { u: l, v: h, pos: [cx + w / 2 - eps, fy + h / 2, cz], rotY: Math.PI / 2 }, // west
    ];
    grids.forEach((g) => {
      const grid = makeGridLines(g.u, g.v, step, gc);
      grid.position.set(...g.pos);
      grid.rotation.y = g.rotY;
      roomGroup.add(grid);
    });
  });
}

// Grid lines in the local XY plane, spanning uSize (x) × vSize (y),
// with a line every `step` meters plus the closing border lines.
function makeGridLines(uSize, vSize, step, color) {
  const pts = [];
  const hu = uSize / 2;
  const hv = vSize / 2;
  for (let u = -hu; u <= hu - 1e-6; u += step) {
    pts.push(u, -hv, 0, u, hv, 0);
  }
  pts.push(hu, -hv, 0, hu, hv, 0); // right border
  for (let v = -hv; v <= hv - 1e-6; v += step) {
    pts.push(-hu, v, 0, hu, v, 0);
  }
  pts.push(-hu, hv, 0, hu, hv, 0); // top border
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
  return new THREE.LineSegments(geo, mat);
}

function makeWallMesh(spanW, spanH, mat, px, py, pz, rotY) {
  const geo = new THREE.PlaneGeometry(spanW, spanH);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(px, py, pz);
  mesh.rotation.y = rotY;
  return mesh;
}

// World center of a door on its wall (base at floor y=0), with the outward
// wall normal. Offset is measured from the wall's LEFT corner as seen from
// inside the room facing that wall.
function doorCenter(door) {
  setRoomCtx(roomOf(door));
  const r = cur();
  const { width: w, length: l, x: cx, z: cz } = r;
  const len = wallLength(door.wall);
  // distance from the LEFT corner to the door's left edge
  const leftEdge = door.side === 'right' ? len - door.offset - door.width : door.offset;
  const along = leftEdge + door.width / 2;
  if (door.wall === 'north') return { x: cx - w / 2 + along, z: cz + l / 2, rotY: 0, nx: 0, nz: 1, floor: r.floor };
  if (door.wall === 'south') return { x: cx + w / 2 - along, z: cz - l / 2, rotY: 0, nx: 0, nz: -1, floor: r.floor };
  if (door.wall === 'east') return { x: cx - w / 2, z: cz - l / 2 + along, rotY: Math.PI / 2, nx: -1, nz: 0, floor: r.floor };
  return { x: cx + w / 2, z: cz + l / 2 - along, rotY: Math.PI / 2, nx: 1, nz: 0, floor: r.floor }; // west
}

// Rectangular door outline, centered horizontally, base at y=0.
function rectShape(dw, dh) {
  const hw = dw / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw, 0);
  s.lineTo(hw, 0);
  s.lineTo(hw, dh);
  s.lineTo(-hw, dh);
  s.lineTo(-hw, 0);
  return s;
}

// Arch outline: rectangle with rounded top corners of radius r (0 = square),
// centered horizontally, base at y=0. r = width/2 gives a semicircular top.
function archShape(dw, dh, r = 0) {
  const hw = dw / 2;
  r = Math.max(0, Math.min(r, hw, dh - 0.001));
  const s = new THREE.Shape();
  s.moveTo(-hw, 0);
  s.lineTo(-hw, dh - r);
  if (r > 0.0001) {
    s.absarc(-hw + r, dh - r, r, Math.PI, Math.PI / 2, true); // top-left corner
    s.lineTo(hw - r, dh);
    s.absarc(hw - r, dh - r, r, Math.PI / 2, 0, true); // top-right corner
  } else {
    s.lineTo(-hw, dh);
    s.lineTo(hw, dh);
  }
  s.lineTo(hw, 0);
  s.lineTo(-hw, 0);
  return s;
}

// Door leaf outline with the hinge edge at local x=0 (spans 0..dw), base y=0.
function leafShape(dw, dh) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(dw, 0);
  s.lineTo(dw, dh);
  s.lineTo(0, dh);
  s.lineTo(0, 0);
  return s;
}

// Per-wall basis: tangent (direction of increasing "along" from the left
// corner) and outward (exterior) normal, plus the mesh Y rotation.
function wallBasis(wall) {
  if (wall === 'north') return { tan: { x: 1, z: 0 }, ex: { x: 0, z: 1 }, rotY: 0 };
  if (wall === 'south') return { tan: { x: -1, z: 0 }, ex: { x: 0, z: -1 }, rotY: 0 };
  if (wall === 'east') return { tan: { x: 0, z: 1 }, ex: { x: -1, z: 0 }, rotY: Math.PI / 2 };
  return { tan: { x: 0, z: -1 }, ex: { x: 1, z: 0 }, rotY: Math.PI / 2 }; // west
}

// Point on the wall surface `along` meters from the left corner (base at the
// current room's floor level; callers add heights to r.floor themselves).
function wallAlongPoint(wall, along) {
  const { width: w, length: l, x: cx, z: cz } = cur();
  if (wall === 'north') return { x: cx - w / 2 + along, z: cz + l / 2 };
  if (wall === 'south') return { x: cx + w / 2 - along, z: cz - l / 2 };
  if (wall === 'east') return { x: cx - w / 2, z: cz - l / 2 + along };
  return { x: cx + w / 2, z: cz + l / 2 - along }; // west
}

function rotateY(v, a) {
  return { x: v.x * Math.cos(a) + v.z * Math.sin(a), z: -v.x * Math.sin(a) + v.z * Math.cos(a) };
}

// A camera-facing text label as a canvas-textured sprite.
function makeTextSprite(text, { color = '#e2e8f0', bg = 'rgba(15,23,42,0.85)', scale = 0.42 } = {}) {
  const fontSize = 48;
  const pad = 14;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${fontSize}px sans-serif`;
  const tw = Math.ceil(ctx.measureText(text).width);
  canvas.width = tw + pad * 2;
  canvas.height = fontSize + pad * 2;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
  );
  sprite.scale.set((scale * canvas.width) / canvas.height, scale, 1);
  sprite.renderOrder = 999;
  return sprite;
}

// A flat panel whose local x → uAxis and local y → vAxis, centered at `center`.
function makePanel(su, sv, uAxis, vAxis, center, mat) {
  const u = new THREE.Vector3(uAxis.x, uAxis.y || 0, uAxis.z).normalize();
  const v = new THREE.Vector3(vAxis.x, vAxis.y || 0, vAxis.z).normalize();
  const n = new THREE.Vector3().crossVectors(u, v).normalize();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(su, sv), mat);
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
  mesh.position.set(center.x, center.y, center.z);
  return mesh;
}

// Reveal (відкоси): the opening's depth surfaces (2 jambs + lintel) that
// extend outward, beyond the room, by `reveal` meters.
function addReveal(door, b, leftEdge, reveal) {
  const h = door.height;
  const fy = cur().floor;
  const ex = b.ex, tan = b.tan;
  const up = { x: 0, y: 1, z: 0 };
  const mat = () => new THREE.MeshStandardMaterial({
    color: 0xcbd5e1, side: THREE.DoubleSide, transparent: true, opacity: 0.55,
  });
  const pL = wallAlongPoint(door.wall, leftEdge);
  const pR = wallAlongPoint(door.wall, leftEdge + door.width);
  const pC = wallAlongPoint(door.wall, leftEdge + door.width / 2);
  const half = reveal / 2;
  // left jamb, right jamb (span depth × height)
  roomGroup.add(makePanel(reveal, h, ex, up,
    { x: pL.x + ex.x * half, y: fy + h / 2, z: pL.z + ex.z * half }, mat()));
  roomGroup.add(makePanel(reveal, h, ex, up,
    { x: pR.x + ex.x * half, y: fy + h / 2, z: pR.z + ex.z * half }, mat()));
  // lintel (span width × depth) at the top
  roomGroup.add(makePanel(door.width, reveal, tan, ex,
    { x: pC.x + ex.x * half, y: fy + h, z: pC.z + ex.z * half }, mat()));
}

// Dimension lines from the room corners to the door edges, along the wall.
function addDoorRuler(door, b, leftEdge, len) {
  const rightGap = len - (leftEdge + door.width);
  const y = cur().floor + 0.04;
  const off = 0.06; // nudge into the room so the ruler is off the wall
  const seg = (a0, a1, val) => {
    if (a1 - a0 < 1e-3) return;
    const p0 = wallAlongPoint(door.wall, a0);
    const p1 = wallAlongPoint(door.wall, a1);
    const nx = -b.ex.x * off, nz = -b.ex.z * off;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(p0.x + nx, y, p0.z + nz),
      new THREE.Vector3(p1.x + nx, y, p1.z + nz),
    ]);
    roomGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf59e0b })));
    const mid = wallAlongPoint(door.wall, (a0 + a1) / 2);
    const lab = makeTextSprite(`${round2(val)} м`, { scale: 0.32, color: '#fbbf24' });
    lab.position.set(mid.x + nx, y + 0.14, mid.z + nz);
    roomGroup.add(lab);
  };
  seg(0, leftEdge, leftEdge);
  seg(leftEdge + door.width, len, rightGap);
}

// Ceiling light: a glowing sphere plus a point light for illumination.
function addLightMesh(light) {
  setRoomCtx(roomOf(light));
  const { width: w, length: l, height: h, floor: fy, x: cx, z: cz } = cur();
  let pos, inner;
  if (light.mount === 'wall') {
    const along = light.side === 'right' ? wallLength(light.wall) - light.offset : light.offset;
    const base = wallAlongPoint(light.wall, along);
    const b = wallBasis(light.wall);
    pos = new THREE.Vector3(base.x - b.ex.x * 0.1, fy + light.elevation, base.z - b.ex.z * 0.1);
    inner = new THREE.Vector3(base.x - b.ex.x * 0.3, fy + light.elevation, base.z - b.ex.z * 0.3);
  } else {
    pos = new THREE.Vector3(cx - w / 2 + light.x, fy + h - 0.06, cz - l / 2 + light.z);
    inner = new THREE.Vector3(cx - w / 2 + light.x, fy + h - 0.15, cz - l / 2 + light.z);
  }
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xfff4c2, emissive: 0xffdf80, emissiveIntensity: 1 }),
  );
  bulb.position.copy(pos);
  bulb.userData = { kind: 'light', id: light.id };
  roomGroup.add(bulb);
  const pl = new THREE.PointLight(0xfff2cc, 3, Math.max(w, l) * 2, 2);
  pl.position.copy(inner);
  roomGroup.add(pl);
}

// A framed picture or a mirror hung flat on a wall, facing the room.
function addWallObjectMesh(obj) {
  setRoomCtx(roomOf(obj));
  const b = wallBasis(obj.wall);
  const along = obj.side === 'right' ? wallLength(obj.wall) - obj.offset : obj.offset;
  const base = wallAlongPoint(obj.wall, along);
  const t = 0.02;

  const group = new THREE.Group();
  group.userData = { kind: 'wallobj', id: obj.id };
  group.position.set(base.x - b.ex.x * t, cur().floor + obj.elevation, base.z - b.ex.z * t);
  const u = new THREE.Vector3(b.tan.x, 0, b.tan.z).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const n = new THREE.Vector3(-b.ex.x, 0, -b.ex.z).normalize(); // interior normal
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, up, n));

  // Frame (slightly larger, sitting against the wall)
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(obj.width + 0.05, obj.height + 0.05, 0.03),
    new THREE.MeshStandardMaterial({ color: obj.color }),
  );
  frame.position.z = -0.015;
  group.add(frame);

  // Face
  let faceMat;
  if (obj.type === 'mirror') {
    faceMat = new THREE.MeshStandardMaterial({ color: 0xdff1ff, metalness: 1, roughness: 0.06 });
  } else {
    const tex = obj.image ? getTexture(obj.image) : null;
    faceMat = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : 0xf1f5f9, map: tex });
  }
  const face = new THREE.Mesh(new THREE.PlaneGeometry(obj.width, obj.height), faceMat);
  face.position.z = 0.006;
  group.add(face);

  roomGroup.add(group);
}

// Name / dimension labels for every object (toggled by the two checkboxes).
function addObjectLabels() {
  const names = state.showDoorLabels; // "Назви обʼєктів"
  const dims = state.showDims;
  if (!names && !dims) return;
  const put = (pos, name, dim) => {
    const parts = [];
    if (names && name) parts.push(name);
    if (dims && dim) parts.push(dim);
    if (!parts.length) return;
    const s = makeTextSprite(parts.join('   '));
    s.position.set(pos.x, pos.y, pos.z);
    roomGroup.add(s);
  };

  state.doors.forEach((d) => {
    const c = doorCenter(d);
    put({ x: c.x - c.nx * 0.06, y: c.floor + (d.height || 2) * 0.5, z: c.z - c.nz * 0.06 },
      d.type === 'arch' ? 'Арка' : 'Двері', `${round2(d.width)}×${round2(d.height)} м`);
  });
  state.elements.forEach((e) => {
    const p = elementWorld(e);
    const [ew, eh] = elemSize(e);
    put({ x: p.x, y: p.y + 0.14, z: p.z }, elemLabel(e), `${round2(ew)}×${round2(eh)} м`);
  });
  state.lights.forEach((l) => {
    const p = lightWorld(l);
    put({ x: p.x, y: p.y - 0.16, z: p.z }, 'Світильник', null);
  });
  state.wallObjects.forEach((o) => {
    setRoomCtx(roomOf(o));
    const along = o.side === 'right' ? wallLength(o.wall) - o.offset : o.offset;
    const base = wallAlongPoint(o.wall, along);
    const b = wallBasis(o.wall);
    put({ x: base.x - b.ex.x * 0.06, y: cur().floor + o.elevation, z: base.z - b.ex.z * 0.06 },
      objTypeLabels[o.type], `${round2(o.width)}×${round2(o.height)} м`);
  });
  state.wires.forEach((wr) => {
    const pts = wireRoutePoints(wr);
    if (!pts) return;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
    const mid = pts[Math.floor(pts.length / 2)] || pts[0];
    put({ x: mid.x, y: mid.y + 0.1, z: mid.z }, 'Провід', `${round2(len)} м`);
  });
}

// ---------- Drywall sheet layout (розкрій ГКЛ) ----------
// drywallLayout / planDrywall live in ./js/drywall.js (pure cutting-stock logic).

// Map a point on a wall (u from left corner, v height) to world space.
function wallUV(wall, u, v) {
  const corner = wallAlongPoint(wall, 0);
  const b = wallBasis(wall);
  const t = 0.02;
  return new THREE.Vector3(
    corner.x + b.tan.x * u - b.ex.x * t, cur().floor + v, corner.z + b.tan.z * u - b.ex.z * t,
  );
}
// Map a point on the ceiling (u along width, v along length) to world space.
function ceilUV(u, v) {
  const r = cur();
  return new THREE.Vector3(r.x - r.width / 2 + u, r.floor + r.height - 0.02, r.z - r.length / 2 + v);
}

// Rectangular door/arch openings on a wall of the CURRENT room (u/v coords).
function wallOpenings(wall) {
  const len = wallLength(wall);
  const roomId = cur().id;
  return state.doors.filter((d) => d.wall === wall && roomOf(d).id === roomId).map((d) => {
    const leftEdge = d.side === 'right' ? len - d.offset - d.width : d.offset;
    return { x0: leftEdge, x1: leftEdge + d.width, y0: 0, y1: d.height };
  });
}

// Reveal (відкоси) drywall surfaces for one door/arch: two jambs and a lintel
// strip, each with a world-mapper so the layout overlay can draw them in place.
function doorRevealSurfaces(door) {
  const reveal = door.reveal || 0;
  if (reveal <= 0) return [];
  setRoomCtx(roomOf(door));
  const fy = cur().floor;
  const len = wallLength(door.wall);
  const leftEdge = door.side === 'right' ? len - door.offset - door.width : door.offset;
  const b = wallBasis(door.wall);
  const pL = wallAlongPoint(door.wall, leftEdge);
  const pR = wallAlongPoint(door.wall, leftEdge + door.width);
  const name = door.type === 'arch' ? 'арки' : 'дверей';
  const where = wallNames[door.wall].toLowerCase();
  return [
    {
      title: `Відкіс ${name} лівий (${where})`, W: reveal, H: door.height, openings: [],
      toWorld: (u, v) => new THREE.Vector3(pL.x + b.ex.x * u, fy + v, pL.z + b.ex.z * u),
    },
    {
      title: `Відкіс ${name} правий (${where})`, W: reveal, H: door.height, openings: [],
      toWorld: (u, v) => new THREE.Vector3(pR.x + b.ex.x * u, fy + v, pR.z + b.ex.z * u),
    },
    {
      title: `Відкіс ${name} верхній (${where})`, W: door.width, H: reveal, openings: [],
      toWorld: (u, v) => new THREE.Vector3(
        pL.x + b.tan.x * u + b.ex.x * v, fy + door.height, pL.z + b.tan.z * u + b.ex.z * v),
    },
  ];
}

// Build the room's drywall surfaces (with a world-mapper each) and hand them to
// the pure planner in ./js/drywall.js. Returns { surfaces, sw, sh, ...plan }.
function computeDrywallPlan() {
  const sw = numVal('gkSheetW', 1.2);
  const sh = numVal('gkSheetH', 2.5);
  if (sw <= 0 || sh <= 0) return null;
  const doWalls = document.getElementById('calcGkStene')?.checked;
  const doCeiling = document.getElementById('calcGkCeiling')?.checked;
  if (!doWalls && !doCeiling) return { surfaces: [], cells: [], empty: true };

  const surfaces = [];
  const many = state.rooms.length > 1;
  const pre = (room) => (many ? `${room.name}: ` : '');
  state.rooms.forEach((room) => {
    setRoomCtx(room);
    if (doWalls) {
      ['north', 'south', 'east', 'west'].forEach((wall) => surfaces.push({
        title: `${pre(room)}${wallNames[wall]} стіна`, W: wallLength(wall), H: room.height,
        openings: wallOpenings(wall),
        toWorld: (u, v) => { setRoomCtx(room); return wallUV(wall, u, v); },
      }));
      // Reveals (відкоси) are drywall surfaces too.
      state.doors.filter((d) => roomOf(d).id === room.id)
        .forEach((d) => surfaces.push(...doorRevealSurfaces(d)));
    }
    if (doCeiling) {
      surfaces.push({
        title: `${pre(room)}Стеля`, W: room.width, H: room.length, openings: [],
        toWorld: (u, v) => { setRoomCtx(room); return ceilUV(u, v); },
      });
    }
  });
  setRoomCtx(null);

  const plan = planDrywall({
    sw, sh, orient: state.dwOrient, stagger: state.dwStagger,
    useLeftovers: state.useLeftovers,
    surfaces: surfaces.map((s) => ({ W: s.W, H: s.H, openings: s.openings })),
  });
  return { surfaces, sw, sh, ...plan };
}

const dwStatusColor = { full: 0x22c55e, 'full-hole': 0x2dd4bf, cut: 0xf97316, offcut: 0x38bdf8, patched: 0xa855f7 };
const dwStatusText = { full: 'ціла', 'full-hole': 'ціла з отвором', cut: 'розріз', offcut: 'із залишку', patched: 'зі шматків' };

const DW_OPACITY = 0.5;        // base translucency of drywall plates
const DW_OPACITY_HOVER = 0.9;  // opacity when the plate is hovered
const drywallMeshes = [];      // pickable plate meshes (rebuilt each buildScene)
let dwHover = null;            // currently highlighted plate

// Translucent plate material tagged so it can be picked/highlighted on hover.
function drywallPlateMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    transparent: true, opacity: DW_OPACITY, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

// Highlight the plate under the cursor (brighten + raise opacity), restore others.
function updateDrywallHover(cx, cy) {
  if (!state.showDrywall || drag || wireDrag) return;
  setNdc(cx, cy);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(drywallMeshes, false)[0];
  const top = hit ? hit.object : null;
  if (top === dwHover) return;
  if (dwHover) {
    dwHover.material.opacity = DW_OPACITY;
    dwHover.material.emissive.setHex(0x000000);
  }
  dwHover = top;
  if (dwHover) {
    dwHover.material.opacity = DW_OPACITY_HOVER;
    dwHover.material.emissive.setHex(0xffffff);
    dwHover.material.emissiveIntensity = 0.35;
  }
  renderer.domElement.style.cursor = dwHover ? 'pointer' : (interactionMode === 'orbit' ? '' : 'crosshair');
}

// Clip a surface opening to one cell → hole rect in u/v coords, or null.
function cellHole(c, o) {
  const x0 = Math.max(c.x, o.x0);
  const x1 = Math.min(c.x + c.w, o.x1);
  const y0 = Math.max(c.y, o.y0);
  const y1 = Math.min(c.y + c.h, o.y1);
  if (x1 - x0 > 1e-3 && y1 - y0 > 1e-3) return { x0, x1, y0, y1 };
  return null;
}

// Filled (opaque) plate geometry for one cell, with door/arch holes cut out.
// Built in u/v space then each vertex is remapped to world via `toWorld`.
function plateGeometry(c, holes, toWorld) {
  const shape = new THREE.Shape();
  shape.moveTo(c.x, c.y);
  shape.lineTo(c.x + c.w, c.y);
  shape.lineTo(c.x + c.w, c.y + c.h);
  shape.lineTo(c.x, c.y + c.h);
  shape.lineTo(c.x, c.y);
  holes.forEach((h) => {
    const path = new THREE.Path();
    path.moveTo(h.x0, h.y0);
    path.lineTo(h.x1, h.y0);
    path.lineTo(h.x1, h.y1);
    path.lineTo(h.x0, h.y1);
    path.lineTo(h.x0, h.y0);
    shape.holes.push(path);
  });
  const geo = new THREE.ShapeGeometry(shape);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const w = toWorld(pos.getX(i), pos.getY(i));
    pos.setXYZ(i, w.x, w.y, w.z);
  }
  pos.needsUpdate = true;
  return geo;
}

// Overlay the sheet layout (translucent colored plates + hole outlines + numbers).
function buildDrywallOverlay() {
  drywallMeshes.length = 0;
  dwHover = null;
  if (!state.showDrywall) return;
  const plan = computeDrywallPlan();
  if (!plan || plan.empty) return;
  plan.cells.forEach((c) => {
    if (c.status === 'skip') return;
    const surf = plan.surfaces[c.si];
    const toWorld = surf.toWorld;
    const holes = surf.openings.map((o) => cellHole(c, o)).filter(Boolean);
    const color = dwStatusColor[c.status] || 0x22c55e;

    // Translucent filled plate (hole cut out for doors/arches).
    const geo = plateGeometry(c, holes, toWorld);
    const mesh = new THREE.Mesh(geo, drywallPlateMaterial(color));
    mesh.userData = { kind: 'drywall' };
    drywallMeshes.push(mesh);
    roomGroup.add(mesh);

    // Cell border on top.
    const border = [toWorld(c.x, c.y), toWorld(c.x + c.w, c.y),
      toWorld(c.x + c.w, c.y + c.h), toWorld(c.x, c.y + c.h), toWorld(c.x, c.y)];
    roomGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(border),
      new THREE.LineBasicMaterial({ color: 0x0f172a }),
    ));

    // Highlight each door/arch cutout so it's clearly visible.
    holes.forEach((h) => {
      const hp = [toWorld(h.x0, h.y0), toWorld(h.x1, h.y0),
        toWorld(h.x1, h.y1), toWorld(h.x0, h.y1), toWorld(h.x0, h.y0)];
      roomGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(hp),
        new THREE.LineBasicMaterial({ color: 0xef4444 }),
      ));
    });

    // Compact label: number (+ ♻ reused / ✂ assembled from scraps). Sizes in the list.
    let label = `№${c.num}`;
    if (c.status === 'offcut') label += '♻';
    else if (c.status === 'patched') label += '✂';
    const s = makeTextSprite(label, { scale: 0.17, color: '#0f172a', bg: 'rgba(255,255,255,0.85)' });
    s.position.copy(toWorld(c.x + c.w / 2, c.y + c.h / 2));
    roomGroup.add(s);
  });

  buildLeftoverOverlay(plan);
}

// Lay the leftover offcuts out flat on the ground in a tidy staging area to the
// LEFT of the room (a "pile of spare pieces"), each labelled with its source
// panel. Kept clearly outside the room so it isn't confused with the walls.
function buildLeftoverOverlay(plan) {
  if (!state.showLeftovers) return;
  const offs = plan.offcuts || [];
  if (!offs.length) return;

  const gap = 0.12;
  const minX = Math.min(...state.rooms.map((r) => r.x - r.width / 2));
  const minZ = Math.min(...state.rooms.map((r) => r.z - r.length / 2));
  const maxZ = Math.max(...state.rooms.map((r) => r.z + r.length / 2));
  const maxRun = Math.max(maxZ - minZ, 4); // column length before wrapping
  const originX = minX - 1.5;               // 1.5 m clear of the leftmost wall
  const originZ = minZ;
  // ground-plane mapper: u runs away from the room (world −x), v front→back (+z)
  const groundUV = (u, v) => new THREE.Vector3(originX - u, 0.03, originZ + v);

  const head = makeTextSprite('ЗАЛИШКИ ГКЛ', { scale: 0.4, color: '#e2e8f0', bg: 'rgba(15,23,42,0.9)' });
  head.position.copy(groundUV(0.5, -0.6));
  roomGroup.add(head);

  let cx = gap;      // distance from the room (grows away)
  let cz = gap;      // position along the column
  let colW = 0;      // widest piece in the current column
  offs.forEach((o) => {
    if (cz + o.h > maxRun && cz > gap) { cx += colW + gap; cz = gap; colW = 0; }
    const cell = { x: cx, y: cz, w: o.w, h: o.h };

    const geo = plateGeometry(cell, [], groundUV);
    const mesh = new THREE.Mesh(geo, drywallPlateMaterial(dwStatusColor.offcut));
    mesh.userData = { kind: 'drywall' };
    drywallMeshes.push(mesh);
    roomGroup.add(mesh);
    const border = [groundUV(cx, cz), groundUV(cx + o.w, cz),
      groundUV(cx + o.w, cz + o.h), groundUV(cx, cz + o.h), groundUV(cx, cz)];
    roomGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(border),
      new THREE.LineBasicMaterial({ color: 0x0f172a }),
    ));
    const src = o.fromNum != null ? ` ←№${o.fromNum}` : '';
    const s = makeTextSprite(`${round2(o.w)}×${round2(o.h)}${src}`, {
      scale: 0.16, color: '#0f172a', bg: 'rgba(255,255,255,0.85)',
    });
    s.position.copy(groundUV(cx + o.w / 2, cz + o.h / 2));
    roomGroup.add(s);

    cz += o.h + gap;
    colW = Math.max(colW, o.w);
  });
}

// Place a door (with hinge/opening) or an arched opening on the correct wall.
function addDoorMesh(door) {
  const c = doorCenter(door);
  const b = wallBasis(door.wall);
  const len = wallLength(door.wall);
  const leftEdge = door.side === 'right' ? len - door.offset - door.width : door.offset;
  const eps = 0.012;
  const reveal = door.reveal || 0;

  // Reveal (відкоси) extending outward; edge ruler — for both types
  if (reveal > 0) addReveal(door, b, leftEdge, reveal);
  if (state.showDoorRuler) addDoorRuler(door, b, leftEdge, len);

  // Threshold (поріг): a low sill spanning the opening at floor level.
  if ((door.threshold || 0) > 0) {
    const th = door.threshold;
    const depth = Math.max(0.1, reveal);
    const mid = wallAlongPoint(door.wall, leftEdge + door.width / 2);
    const sill = new THREE.Mesh(
      new THREE.BoxGeometry(door.width, th, depth),
      new THREE.MeshStandardMaterial({ color: 0x94a3b8 }),
    );
    sill.position.set(mid.x + b.ex.x * (depth / 2 - 0.02), c.floor + th / 2, mid.z + b.ex.z * (depth / 2 - 0.02));
    sill.rotation.y = b.rotY;
    sill.userData = { kind: 'door', id: door.id };
    roomGroup.add(sill);
  }

  // --- Arch: an open passage (no leaf), square by default, roundable top ---
  if (door.type === 'arch') {
    const geo = new THREE.ShapeGeometry(archShape(door.width, door.height, door.radius || 0));
    const mat = new THREE.MeshStandardMaterial({
      color: door.color, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(c.x + c.nx * eps, c.floor, c.z + c.nz * eps);
    mesh.rotation.y = c.rotY;
    mesh.userData = { kind: 'door', id: door.id };
    roomGroup.add(mesh);
    return;
  }

  // --- Door: opening outline on the wall + a swinging leaf + casing ---
  // How far the leaf sits into the reveal, measured from the interior face.
  const inset = Math.max(0, Math.min(door.inset || 0, reveal));

  // Opening outline stays on the wall so the doorway is visible when open
  const outlineGeo = new THREE.EdgesGeometry(new THREE.ShapeGeometry(rectShape(door.width, door.height)));
  const outline = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0x0f172a }));
  outline.position.set(c.x + c.nx * eps * 0.4, c.floor, c.z + c.nz * eps * 0.4);
  outline.rotation.y = c.rotY;
  roomGroup.add(outline);

  // Casing (лиштва) eats `casing` off each side + the top; the leaf fits the
  // inner opening and is hinged at the inner edge of the casing.
  const casing = door.casing || 0;
  const innerW = Math.max(0.01, door.width - 2 * casing);
  const innerH = Math.max(0.01, door.height - casing);
  const innerLeft = leftEdge + casing; // inner opening left edge, from left corner

  // Hinge position (inner left/right edge of the casing opening)
  const hinge = door.hinge === 'right' ? 'right' : 'left';
  const hingeAlong = hinge === 'left' ? innerLeft : innerLeft + innerW;
  const hp = wallAlongPoint(door.wall, hingeAlong);

  // Swing: rotate the closed leaf direction toward the interior or exterior
  const theta = THREE.MathUtils.degToRad(Math.max(0, Math.min(120, door.openAngle ?? 90)));
  const bodySign = hinge === 'left' ? 1 : -1;
  const closedDir = { x: bodySign * b.tan.x, z: bodySign * b.tan.z };
  const target = door.openDir === 'out' ? b.ex : { x: -b.ex.x, z: -b.ex.z };
  const d1 = rotateY(closedDir, theta);
  const d2 = rotateY(closedDir, -theta);
  const dot = (u, v) => u.x * v.x + u.z * v.z;
  const openedDir = dot(d1, target) >= dot(d2, target) ? d1 : d2;
  const psi = Math.atan2(-openedDir.z, openedDir.x);

  // Leaf material: image texture fitted to the leaf, or a flat color
  const doorTex = door.image
    ? getTexture(door.image, `${door.image}|d|${round2(innerW)}x${round2(innerH)}`, (t) => {
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.repeat.set(1 / innerW, 1 / innerH);
    })
    : null;
  const leaf = new THREE.Mesh(
    new THREE.ShapeGeometry(leafShape(innerW, innerH)),
    new THREE.MeshStandardMaterial({ color: doorTex ? 0xffffff : door.color, map: doorTex, side: THREE.DoubleSide }),
  );
  leaf.position.set(hp.x + c.nx * (eps + inset), c.floor, hp.z + c.nz * (eps + inset));
  leaf.rotation.y = psi;
  leaf.userData = { kind: 'door', id: door.id };
  roomGroup.add(leaf);

  // Casing frame — an inner frame eating into the opening from the edges
  if (casing > 0 && innerW > 0.01 && innerH > 0.01) {
    const outer = rectShape(door.width, door.height);
    outer.holes.push(rectShape(innerW, innerH));
    const frame = new THREE.Mesh(
      new THREE.ShapeGeometry(outer),
      new THREE.MeshStandardMaterial({ color: door.casingColor ?? door.color, side: THREE.DoubleSide }),
    );
    frame.position.set(c.x - c.nx * eps, c.floor, c.z - c.nz * eps);
    frame.rotation.y = c.rotY;
    roomGroup.add(frame);
  }
}

// ---------- Electrical elements & wiring ----------
// World position (on the wall surface, slightly protruding inward) of a point
// `along` meters from the left corner at height `y`.
function wallPoint(wall, along, y) {
  const { width: w, length: l, x: cx, z: cz, floor: fy } = cur();
  const t = 0.03; // protrude inward so it is visible from inside the room
  const wy = fy + y;
  if (wall === 'north') return { x: cx - w / 2 + along, y: wy, z: cz + l / 2 - t, rotY: 0 };
  if (wall === 'south') return { x: cx + w / 2 - along, y: wy, z: cz - l / 2 + t, rotY: 0 };
  if (wall === 'east') return { x: cx - w / 2 + t, y: wy, z: cz - l / 2 + along, rotY: Math.PI / 2 };
  return { x: cx + w / 2 - t, y: wy, z: cz + l / 2 - along, rotY: Math.PI / 2 }; // west
}

// distance from the LEFT corner, honoring the element's reference side
function elemAlong(el) {
  return el.side === 'right' ? wallLength(el.wall) - el.offset : el.offset;
}

function elementWorld(el) {
  setRoomCtx(roomOf(el));
  return wallPoint(el.wall, elemAlong(el), el.elevation);
}

// World position of a light (ceiling or wall mounted).
function lightWorld(l) {
  setRoomCtx(roomOf(l));
  const r = cur();
  if (l.mount === 'wall') {
    const along = l.side === 'right' ? wallLength(l.wall) - l.offset : l.offset;
    const base = wallAlongPoint(l.wall, along);
    const b = wallBasis(l.wall);
    return { x: base.x - b.ex.x * 0.1, y: r.floor + l.elevation, z: base.z - b.ex.z * 0.1 };
  }
  return { x: r.x - r.width / 2 + l.x, y: r.floor + r.height - 0.06, z: r.z - r.length / 2 + l.z };
}

// A wire endpoint / via-point can be an electrical element OR a light.
function findNode(id) {
  return state.elements.find((e) => e.id === id) || state.lights.find((l) => l.id === id) || null;
}
function nodeWorld(node) {
  return node.mount !== undefined || String(node.id).startsWith('lt-') ? lightWorld(node) : elementWorld(node);
}
function nodeLabel(node) {
  if (!node) return '?';
  if (node.mount !== undefined || String(node.id).startsWith('lt-')) return 'Світильник';
  return elemLabel(node);
}

function addElementMesh(el) {
  const meta = elementTypes[el.type] || elementTypes.socket;
  const [ew, eh] = elemSize(el);
  const p = wallPoint(el.wall, elemAlong(el), el.elevation);

  const group = new THREE.Group();
  group.position.set(p.x, p.y, p.z);
  // Face the interior: local +z must point along the inward normal (−ex).
  group.rotation.y = p.rotY + (el.wall === 'north' || el.wall === 'west' ? Math.PI : 0);
  group.userData = { kind: 'element', id: el.id };

  const box = (w, h, color, x = 0, y = 0, z = 0, d = 0.05) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
    m.position.set(x, y, z);
    group.add(m);
  };

  if (meta.combo) {
    // Socket below, switch above — one vertical unit.
    box(ew, eh / 2 - 0.005, elementTypes.socket.color, 0, -eh / 4);
    box(ew, eh / 2 - 0.005, elementTypes.switch.color, 0, eh / 4);
  } else if (meta.gangs > 1 && !meta.keys) {
    // Multi-gang socket: one frame with N round-ish modules side by side.
    const unit = ew / meta.gangs;
    box(ew, eh, 0xd1d5db, 0, 0, 0, 0.04); // frame
    for (let i = 0; i < meta.gangs; i++) {
      box(unit * 0.72, eh * 0.72, meta.color, -ew / 2 + unit * (i + 0.5), 0, 0.012, 0.045);
    }
  } else if (meta.keys) {
    // Multi-key switch: a single box with N vertical keys.
    box(ew, eh, meta.color);
    const kw = ew / meta.gangs;
    for (let i = 0; i < meta.gangs; i++) {
      box(kw * 0.6, eh * 0.7, 0xfef3c7, -ew / 2 + kw * (i + 0.5), 0, 0.028, 0.012);
    }
  } else if (el.type === 'wireout') {
    // Bare cable outlet: small plate with a protruding wire loop stub.
    box(ew, eh, meta.color, 0, 0, 0, 0.02);
    const stub = new THREE.Mesh(
      new THREE.TorusGeometry(0.035, 0.008, 8, 14, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x1f2937 }),
    );
    stub.position.set(0, 0.01, 0.03);
    group.add(stub);
  } else {
    box(ew, eh, meta.color);
  }

  roomGroup.add(group);
}

// Which room surface a world point sits on (used to route along surfaces).
// Checks every room; returns the room the surface belongs to.
function nodeSurface(p) {
  for (const room of state.rooms) {
    setRoomCtx(room);
    if (Math.abs(p.x - room.x) <= room.width / 2 + 0.25 &&
        Math.abs(p.z - room.z) <= room.length / 2 + 0.25) {
      if (p.y >= room.floor + room.height - 0.1) return { type: 'ceiling', room };
      for (const wall of ['north', 'south', 'east', 'west']) {
        const b = wallBasis(wall);
        const corner = wallAlongPoint(wall, 0);
        const dist = Math.abs((p.x - corner.x) * b.ex.x + (p.z - corner.z) * b.ex.z);
        const along = (p.x - corner.x) * b.tan.x + (p.z - corner.z) * b.tan.z;
        if (dist < 0.25 && along > -0.25 && along < wallLength(wall) + 0.25) {
          return { type: 'wall', wall, room };
        }
      }
    }
  }
  setRoomCtx(null);
  return { type: 'free', room: roomAtPoint(p) || activeRoom() };
}

// Orthogonal route for one leg P→Q, staying on walls/ceiling (returns points
// after P, including Q), with 90° turns only. `forceCeiling` always goes up
// over the ceiling. When P and Q sit in different rooms, the run goes at the
// lower of the two ceiling levels so the horizontal crossing pierces the
// shared wall and still fits under both ceilings.
function orthoLeg(P, Q, forceCeiling) {
  const sp = nodeSurface(P);
  const sq = nodeSurface(Q);
  const rp = sp.room || activeRoom();
  const rq = sq.room || rp;
  const sameRoom = rp.id === rq.id;
  if (!forceCeiling && sameRoom && sp.type === 'wall' && sq.type === 'wall' && sp.wall === sq.wall) {
    return [new THREE.Vector3(Q.x, P.y, Q.z), Q]; // L on the same wall
  }
  const cy = Math.min(rp.floor + rp.height, rq.floor + rq.height) - 0.02;
  const res = [];
  if (Math.abs(P.y - cy) > 1e-4) res.push(new THREE.Vector3(P.x, cy, P.z)); // up/down the wall
  // Across the ceiling strictly with 90° turns (Manhattan, no diagonals).
  if (Math.abs(P.x - Q.x) > 1e-4 && Math.abs(P.z - Q.z) > 1e-4) {
    res.push(new THREE.Vector3(Q.x, cy, P.z));
  }
  if (Math.abs(Q.y - cy) > 1e-4) res.push(new THREE.Vector3(Q.x, cy, Q.z));
  res.push(Q); // down to Q (or straight if Q at run level)
  return res;
}

// Point-list of a wire's route as an array of THREE.Vector3.
// Returns null if either endpoint is missing.
function wireRoutePoints(wire) {
  const from = findNode(wire.from);
  const to = findNode(wire.to);
  if (!from || !to) return null;
  const a = nodeWorld(from);
  const b = nodeWorld(to);
  const A = new THREE.Vector3(a.x, a.y, a.z);
  const B = new THREE.Vector3(b.x, b.y, b.z);

  // Resolve manual waypoints — either free {x,y,z} or linked to a device {node}.
  const mids = (Array.isArray(wire.points) ? wire.points : []).map((p) => {
    if (p.node) { const n = findNode(p.node); if (!n) return null; const w = nodeWorld(n); return new THREE.Vector3(w.x, w.y, w.z); }
    return new THREE.Vector3(p.x, p.y, p.z);
  }).filter(Boolean);
  const nodes = [A, ...mids, B];

  // Routes are always orthogonal: 90° turns only, along walls and ceiling.
  let pts = [A];
  for (let i = 1; i < nodes.length; i++) pts.push(...orthoLeg(nodes[i - 1], nodes[i], wire.ceiling));

  // Parallel cables (lane > 0) are shifted sideways beside the original.
  if (wire.lane) {
    const dir = new THREE.Vector3(B.x - A.x, 0, B.z - A.z);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(wire.lane * 0.05);
    pts = pts.map((p) => p.clone().add(perp));
  }
  return pts;
}

function wireIsRouted(wire) {
  if (wire.ceiling || (Array.isArray(wire.points) && wire.points.length > 0)) return true;
  const f = findNode(wire.from);
  const t = findNode(wire.to);
  const key = (n) => `${roomOf(n).id}|${n.wall || 'ceiling'}`;
  return f && t && key(f) !== key(t);
}

function addWireMesh(wire) {
  const pts = wireRoutePoints(wire);
  if (!pts) return;
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: wireIsRouted(wire) ? 0x38bdf8 : 0xef4444,
  }));
  line.userData = { kind: 'wireline', id: wire.id };
  roomGroup.add(line);

  // Draggable control-point handles.
  if (Array.isArray(wire.points)) {
    wire.points.forEach((p, i) => {
      const handle = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0x7a5b00, emissiveIntensity: 0.6 }),
      );
      handle.position.set(p.x, p.y, p.z);
      handle.userData = { kind: 'wirepoint', id: wire.id, index: i };
      roomGroup.add(handle);
    });
  }
}

// Frame the camera to fit all rooms nicely
function frameCamera() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity, minY = Infinity;
  state.rooms.forEach((r) => {
    minX = Math.min(minX, r.x - r.width / 2);
    maxX = Math.max(maxX, r.x + r.width / 2);
    minZ = Math.min(minZ, r.z - r.length / 2);
    maxZ = Math.max(maxZ, r.z + r.length / 2);
    minY = Math.min(minY, r.floor);
    maxY = Math.max(maxY, r.floor + r.height);
  });
  const w = maxX - minX, l = maxZ - minZ, h = maxY - minY;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const maxDim = Math.max(w, l, h);
  const dist = maxDim * 1.8 + 3;
  camera.position.set(cx + w * 0.4 + dist * 0.4, maxY + dist * 0.5, cz + l * 0.4 + dist);
  controls.target.set(cx, minY + h / 2, cz);
  controls.update();
}

// ---------- Rendering loop ----------
function resize() {
  const width = canvasWrap.clientWidth;
  const height = canvasWrap.clientHeight;
  if (!width || !height) return; // canvas hidden (parked in holder)
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', resize);

// ---------- Tab switching ----------
// The single WebGL canvas is moved into whichever 3D tab (constructor / wire)
// is active, or parked in a hidden holder for the other tabs.
function switchTab(name) {
  if (!hasProject && name !== 'file') return; // other tabs locked until a project exists
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.dataset.tab === name);
  });
  const host = document.querySelector(`#tab-${name} .canvas-host`);
  const wrap = document.getElementById('canvas-wrap');
  if (host) {
    host.appendChild(wrap);
    requestAnimationFrame(resize); // canvas had zero size while hidden
  } else {
    document.getElementById('canvas-holder').appendChild(wrap);
  }
  if (name === 'wire') setMode('wire');
  else if (name === 'constructor') setMode('orbit');
}

document.querySelectorAll('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

// Lock/unlock the non-file tabs and toggle the file-tab tools for the
// "no project yet" vs "project open" states.
function setHasProject(v) {
  hasProject = v;
  ['constructor', 'wire', 'calc'].forEach((t) => {
    const btn = document.querySelector(`.tab-btn[data-tab="${t}"]`);
    if (btn) btn.disabled = !v;
  });
  els.fileTools.hidden = !v;
  if (!v) switchTab('file');
}

// ---------- Calculations ----------
// Wall areas for one room (doors of that room subtracted from the total).
function computeRoomAreas(room) {
  const { width: w, length: l, height: h } = room;
  const walls = {
    north: round2(w * h),
    south: round2(w * h),
    east: round2(l * h),
    west: round2(l * h),
  };
  const gross = 2 * (w + l) * h;
  const doorsArea = state.doors
    .filter((d) => roomOf(d).id === room.id)
    .reduce((s, d) => s + d.width * d.height, 0);
  const net = gross - doorsArea;
  return {
    walls,
    gross: round2(gross),
    doorsArea: round2(doorsArea),
    net: round2(net),
  };
}

// Totals over all rooms (kept for the calculators that want one number).
function computeAreas() {
  const total = { gross: 0, doorsArea: 0, net: 0 };
  state.rooms.forEach((r) => {
    const a = computeRoomAreas(r);
    total.gross += a.gross;
    total.doorsArea += a.doorsArea;
    total.net += a.net;
  });
  total.gross = round2(total.gross);
  total.doorsArea = round2(total.doorsArea);
  total.net = round2(total.net);
  return total;
}

// ---------- UI rendering ----------
const els = {
  roomSelect: document.getElementById('roomSelect'),
  addRoomBtn: document.getElementById('addRoomBtn'),
  delRoomBtn: document.getElementById('delRoomBtn'),
  roomName: document.getElementById('roomName'),
  roomPosX: document.getElementById('roomPosX'),
  roomPosZ: document.getElementById('roomPosZ'),
  roomFloor: document.getElementById('roomFloor'),
  thickN: document.getElementById('thickN'),
  thickS: document.getElementById('thickS'),
  thickE: document.getElementById('thickE'),
  thickW: document.getElementById('thickW'),
  roomWidth: document.getElementById('roomWidth'),
  roomLength: document.getElementById('roomLength'),
  roomHeight: document.getElementById('roomHeight'),
  showCeiling: document.getElementById('showCeiling'),
  gridStep: document.getElementById('gridStep'),
  showWallGrid: document.getElementById('showWallGrid'),
  showDoorLabels: document.getElementById('showDoorLabels'),
  showDims: document.getElementById('showDims'),
  showDoorRuler: document.getElementById('showDoorRuler'),
  showDrywall: document.getElementById('showDrywall'),
  showLeftovers: document.getElementById('showLeftovers'),
  useLeftovers: document.getElementById('useLeftovers'),
  dwOrient: document.getElementById('dwOrient'),
  dwStagger: document.getElementById('dwStagger'),
  wallColor: document.getElementById('wallColor'),
  wallOpaque: document.getElementById('wallOpaque'),
  wallImageFile: document.getElementById('wallImageFile'),
  wallImageClear: document.getElementById('wallImageClear'),
  floorColor: document.getElementById('floorColor'),
  doorType: document.getElementById('doorType'),
  doorWall: document.getElementById('doorWall'),
  doorSide: document.getElementById('doorSide'),
  doorOffset: document.getElementById('doorOffset'),
  doorWidth: document.getElementById('doorWidth'),
  doorHeight: document.getElementById('doorHeight'),
  doorCasing: document.getElementById('doorCasing'),
  doorCasingColor: document.getElementById('doorCasingColor'),
  doorRadius: document.getElementById('doorRadius'),
  doorReveal: document.getElementById('doorReveal'),
  doorThreshold: document.getElementById('doorThreshold'),
  doorInset: document.getElementById('doorInset'),
  doorColor: document.getElementById('doorColor'),
  doorImageFile: document.getElementById('doorImageFile'),
  doorImageClear: document.getElementById('doorImageClear'),
  doorHinge: document.getElementById('doorHinge'),
  doorOpenDir: document.getElementById('doorOpenDir'),
  doorOpenAngle: document.getElementById('doorOpenAngle'),
  doorCasingField: document.getElementById('doorCasingField'),
  doorRadiusField: document.getElementById('doorRadiusField'),
  doorOpenGroup: document.getElementById('doorOpenGroup'),
  addDoorBtn: document.getElementById('addDoorBtn'),
  cancelEditBtn: document.getElementById('cancelEditBtn'),
  doorFormTitle: document.getElementById('doorFormTitle'),
  doorError: document.getElementById('doorError'),
  doorList: document.getElementById('doorList'),
  elemType: document.getElementById('elemType'),
  elemWall: document.getElementById('elemWall'),
  elemSide: document.getElementById('elemSide'),
  elemSizeRow: document.getElementById('elemSizeRow'),
  elemWidth: document.getElementById('elemWidth'),
  elemHeight: document.getElementById('elemHeight'),
  elemOffset: document.getElementById('elemOffset'),
  elemElevation: document.getElementById('elemElevation'),
  addElemBtn: document.getElementById('addElemBtn'),
  cancelElemBtn: document.getElementById('cancelElemBtn'),
  elemFormTitle: document.getElementById('elemFormTitle'),
  elemError: document.getElementById('elemError'),
  elemList: document.getElementById('elemList'),
  wireFrom: document.getElementById('wireFrom'),
  wireTo: document.getElementById('wireTo'),
  wireCeiling: document.getElementById('wireCeiling'),
  wireCable: document.getElementById('wireCable'),
  wireCores: document.getElementById('wireCores'),
  wireDiam: document.getElementById('wireDiam'),
  cpChip: document.getElementById('cpChip'),
  addWireBtn: document.getElementById('addWireBtn'),
  wireError: document.getElementById('wireError'),
  wireList: document.getElementById('wireList'),
  lightMount: document.getElementById('lightMount'),
  lightCeilingFields: document.getElementById('lightCeilingFields'),
  lightWallFields: document.getElementById('lightWallFields'),
  lightX: document.getElementById('lightX'),
  lightZ: document.getElementById('lightZ'),
  lightWall: document.getElementById('lightWall'),
  lightSide: document.getElementById('lightSide'),
  lightOffset: document.getElementById('lightOffset'),
  lightElevation: document.getElementById('lightElevation'),
  addLightBtn: document.getElementById('addLightBtn'),
  lightError: document.getElementById('lightError'),
  lightList: document.getElementById('lightList'),
  objType: document.getElementById('objType'),
  objWall: document.getElementById('objWall'),
  objSide: document.getElementById('objSide'),
  objOffset: document.getElementById('objOffset'),
  objElevation: document.getElementById('objElevation'),
  objWidth: document.getElementById('objWidth'),
  objHeight: document.getElementById('objHeight'),
  objColor: document.getElementById('objColor'),
  objImageFile: document.getElementById('objImageFile'),
  objImageClear: document.getElementById('objImageClear'),
  objImageField: document.getElementById('objImageField'),
  addObjBtn: document.getElementById('addObjBtn'),
  cancelObjBtn: document.getElementById('cancelObjBtn'),
  objFormTitle: document.getElementById('objFormTitle'),
  objError: document.getElementById('objError'),
  objList: document.getElementById('objList'),
  results: document.getElementById('results'),
  newProjectBtn: document.getElementById('newProjectBtn'),
  fileTools: document.getElementById('fileTools'),
  saveBtn: document.getElementById('saveBtn'),
  overwriteBtn: document.getElementById('overwriteBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),
  ioMsg: document.getElementById('ioMsg'),
};

// Handle of the currently opened/saved file (File System Access API), if any.
let fileHandle = null;

function renderDoorList() {
  els.doorList.innerHTML = '';
  if (state.doors.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Двері ще не додані.';
    els.doorList.appendChild(li);
    return;
  }
  state.doors.forEach((door) => {
    const li = document.createElement('li');
    if (door.id === editingId) li.className = 'editing';

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colorHex(door.color);

    const info = document.createElement('span');
    info.className = 'door-info';
    const typeLabel = door.type === 'arch' ? 'Арка' : 'Двері';
    const sideLabel = door.side === 'right' ? 'справа' : 'зліва';
    const casingLabel = door.casing > 0 ? ` · лиштва ${door.casing} м` : '';
    const revealLabel = door.reveal > 0 ? ` · відкоси ${door.reveal} м` : '';
    const thresholdLabel = door.threshold > 0 ? ` · поріг ${door.threshold} м` : '';
    const roomLabel = state.rooms.length > 1 ? `${roomOf(door).name} · ` : '';
    info.innerHTML =
      `<strong>${roomLabel}${typeLabel} — ${wallNames[door.wall]}</strong><br>` +
      `зсув ${door.offset} м (${sideLabel}) · ${door.width}×${door.height} м${casingLabel}${revealLabel}${thresholdLabel}`;

    const actions = document.createElement('span');
    actions.className = 'actions';

    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.textContent = 'Редагувати';
    edit.addEventListener('click', () => startEdit(door.id));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Видалити';
    del.addEventListener('click', () => {
      pushHistory();
      if (door.id === editingId) cancelEdit();
      state.doors = state.doors.filter((d) => d.id !== door.id);
      buildScene();
      renderDoorList();
      renderResults();
    });

    actions.appendChild(edit);
    actions.appendChild(del);
    li.appendChild(swatch);
    li.appendChild(info);
    li.appendChild(actions);
    els.doorList.appendChild(li);
  });
}

function renderResults() {
  let html = '';
  const many = state.rooms.length > 1;
  state.rooms.forEach((r) => {
    const a = computeRoomAreas(r);
    if (many) html += `<div class="row total"><span>${r.name}</span><span></span></div>`;
    html +=
      row('Північна стіна', a.walls.north) +
      row('Південна стіна', a.walls.south) +
      row('Східна стіна', a.walls.east) +
      row('Західна стіна', a.walls.west) +
      row('Площа стін', a.gross, !many) +
      row('Площа дверей', a.doorsArea) +
      row('Чиста площа стін', a.net, !many);
  });
  if (many) {
    const t = computeAreas();
    html += row('Разом: площа стін', t.gross, true) +
      row('Разом: площа дверей', t.doorsArea) +
      row('Разом: чиста площа', t.net, true);
  }
  els.results.innerHTML = html;
}

function row(label, value, total = false) {
  return (
    `<div class="row${total ? ' total' : ''}">` +
    `<span>${label}</span>` +
    `<span class="val">${value.toFixed(2)} м²</span>` +
    `</div>`
  );
}

// ---------- Detailed calculations (Розрахунки tab) ----------
// A single label/value line in a calc block.
function calcRow(label, value, total = false) {
  return (
    `<div class="calc-row${total ? ' calc-total' : ''}">` +
    `<span>${label}</span>` +
    `<span class="val">${value}</span>` +
    `</div>`
  );
}

function numVal(id, fallback) {
  const el = document.getElementById(id);
  const v = parseFloat(el && el.value);
  return isFinite(v) ? v : fallback;
}

function renderCalculations() {
  renderGkCalc();
  renderRailCalc();
  renderPlinthCalc();
  renderWireCalc();
  renderDrywallCalc();
}

// Floor + ceiling baseboard (плінтус) from the room perimeter. Door/arch
// openings interrupt the floor run; the ceiling run is the full perimeter.
function renderPlinthCalc() {
  const out = document.getElementById('plinthResults');
  if (!out) return;
  const doFloor = document.getElementById('plinthFloor')?.checked;
  const doCeiling = document.getElementById('plinthCeiling')?.checked;
  const piece = numVal('plinthPiece', 2.5);
  const waste = numVal('plinthWaste', 5);
  if (piece <= 0) { out.innerHTML = '<p class="calc-empty">Вкажіть коректну довжину планки.</p>'; return; }
  if (!doFloor && !doCeiling) { out.innerHTML = '<p class="calc-empty">Оберіть підлоговий та/або стельовий плінтус.</p>'; return; }

  const perimeter = state.rooms.reduce((s, r) => s + 2 * (r.width + r.length), 0);
  const openWidth = state.doors.reduce((s, d) => s + (d.width || 0), 0);
  const thresholds = state.doors.filter((d) => (d.threshold || 0) > 0);
  const thresholdWidth = thresholds.reduce((s, d) => s + (d.width || 0), 0);
  const factor = 1 + waste / 100;

  let html = calcRow(state.rooms.length > 1 ? 'Периметр усіх кімнат' : 'Периметр кімнати',
    `${round2(perimeter).toFixed(2)} м`);
  let totalPieces = 0;
  if (doFloor) {
    const len = Math.max(0, perimeter - openWidth);
    const pcs = Math.ceil((len * factor) / piece);
    totalPieces += pcs;
    html += calcRow('Підлоговий: довжина', `${round2(len).toFixed(2)} м`);
    if (openWidth > 0) html += calcRow('  − прорізи дверей/арок', `${round2(openWidth).toFixed(2)} м`);
    if (thresholds.length) {
      html += calcRow('  у т.ч. пороги (плінтус не рахується)',
        `${thresholds.length} шт · ${round2(thresholdWidth).toFixed(2)} м`);
    }
    html += calcRow('Підлоговий: планок', `${pcs} шт`);
  }
  if (doCeiling) {
    const pcs = Math.ceil((perimeter * factor) / piece);
    totalPieces += pcs;
    html += calcRow('Стельовий: довжина', `${round2(perimeter).toFixed(2)} м`);
    html += calcRow('Стельовий: планок', `${pcs} шт`);
  }
  html += calcRow(`Разом планок (${round2(piece)} м, запас ${round2(waste)}%)`, `${totalPieces} шт`, true);
  out.innerHTML = html;
}

// Sheet-by-sheet drywall layout (numbers + cut sizes) for selected surfaces.
function renderDrywallCalc() {
  const out = document.getElementById('dwResults');
  if (!out) return;
  const plan = computeDrywallPlan();
  if (!plan) { out.innerHTML = '<p class="calc-empty">Вкажіть коректний розмір плити.</p>'; return; }
  if (plan.empty) { out.innerHTML = '<p class="calc-empty">Оберіть стіни та/або стелю у блоці «Гіпсокартон».</p>'; return; }

  let html = `<p class="calc-note">Плита ${round2(plan.sw)}×${round2(plan.sh)} м. Отвори дверей/арок вирізано; залишки повторно використано для інших ділянок (♻).</p>`;
  plan.surfaces.forEach((surf, si) => {
    const cells = plan.cells.filter((c) => c.si === si && c.status !== 'skip');
    if (!cells.length) { html += `<p class="calc-note">${surf.title}: повністю в отворах</p>`; return; }
    html += `<p class="calc-note">${surf.title}</p>`;
    cells.forEach((c) => {
      const tag = dwStatusText[c.status] || '';
      let src = '';
      if (c.status === 'offcut' && c.fromNum != null) src = ` із №${c.fromNum}`;
      else if (c.status === 'patched' && c.builtFromNums?.length) src = ` із №${c.builtFromNums.join(', №')}`;
      html += calcRow(`№${c.num} (${tag}${src})`, `${round2(c.w)}×${round2(c.h)} м`);
    });
  });

  // Leftover offcuts, listed as full panels with the panel they were cut from.
  const offs = plan.offcuts || [];
  if (offs.length) {
    html += `<p class="calc-note">Залишки (придатні до використання)</p>`;
    offs.forEach((o, i) => {
      const src = o.fromNum != null ? ` (з плити №${o.fromNum})` : '';
      html += calcRow(`Залишок ${i + 1}${src}`, `${round2(o.w)}×${round2(o.h)} м`);
    });
  }

  const bought = plan.newSheets;
  html += calcRow('Нових плит (закупівля)', `${bought} шт`, true);
  html += calcRow('Заповнено із залишків ♻', `${plan.reused} шт`);
  if (plan.assembled) html += calcRow('Зібрано зі шматків (економія плит)', `${plan.assembled} шт`);
  html += calcRow('Плит в отворах (пропущено)', `${plan.skipped} шт`);
  html += calcRow('Залишків (шт)', `${offs.length} шт`);
  html += calcRow('Придатних залишків', `${round2(plan.leftover)} м²`);
  out.innerHTML = html;
}

// BLOCK 1: гіпсокартон
function renderGkCalc() {
  const out = document.getElementById('gkResults');
  if (!out) return;
  const stene = document.getElementById('calcGkStene').checked;
  const ceiling = document.getElementById('calcGkCeiling').checked;
  const sheetW = numVal('gkSheetW', 1.2);
  const sheetH = numVal('gkSheetH', 2.5);
  const waste = numVal('gkWaste', 10);

  const revealArea = state.doors.reduce((s, d) => {
    const r = d.reveal || 0;
    return s + (r > 0 ? 2 * r * d.height + r * d.width : 0);
  }, 0);
  const wallArea = computeAreas().net + revealArea;
  const ceilingArea = state.rooms.reduce((s, r) => s + r.width * r.length, 0);
  const sheetArea = sheetW * sheetH;
  const factor = 1 + waste / 100;

  let html = '';
  let totalSheets = 0;
  let totalArea = 0;
  if (sheetArea > 0) {
    if (stene) {
      const s = Math.ceil((wallArea * factor) / sheetArea);
      totalSheets += s;
      totalArea += wallArea;
      html += calcRow('Площа стін', `${round2(wallArea).toFixed(2)} м²`);
      if (revealArea > 0) html += calcRow('  у т.ч. відкоси', `${round2(revealArea).toFixed(2)} м²`);
      html += calcRow('Листів на стіни', `${s} шт`);
    }
    if (ceiling) {
      const s = Math.ceil((ceilingArea * factor) / sheetArea);
      totalSheets += s;
      totalArea += ceilingArea;
      html += calcRow('Площа стелі', `${round2(ceilingArea).toFixed(2)} м²`);
      html += calcRow('Листів на стелю', `${s} шт`);
    }
    html += calcRow('Площа одного листа', `${round2(sheetArea).toFixed(2)} м²`);
    if (!stene && !ceiling) {
      html = `<p class="calc-empty">Оберіть стіни та/або стелю.</p>`;
    } else {
      html += calcRow('Загальна площа', `${round2(totalArea).toFixed(2)} м²`);
      html += calcRow(`Рекомендовано листів (відходи ${round2(waste)}%)`, `${totalSheets} шт`, true);
    }
  } else {
    html = `<p class="calc-empty">Вкажіть коректний розмір листа.</p>`;
  }
  out.innerHTML = html;
}

// BLOCK 2: рейки/профілі на стелю
function renderRailCalc() {
  const out = document.getElementById('railResults');
  if (!out) return;
  const step = numVal('railStep', 0.6);
  const stock = numVal('railStock', 3);

  if (step <= 0 || stock <= 0) {
    out.innerHTML = `<p class="calc-empty">Вкажіть коректні крок та довжину профілю.</p>`;
    return;
  }

  // Sum the frame over every room's ceiling.
  let lengthUD = 0, lengthCD = 0, hangers = 0, crabs = 0;
  state.rooms.forEach(({ width: w, length: l }) => {
    // UD (направляючий) — периметр
    lengthUD += 2 * (w + l);
    // CD несучий — ряди вздовж length, кожен на всю ширину
    const rows = Math.floor(l / step) + 1;
    lengthCD += rows * w;
    // Прямі підвіси — кожні ~0.6 м уздовж кожного ряду CD
    hangers += rows * (Math.floor(w / 0.6) + 1);
    // Краби — перетини сітки (поперечні CD кожні step по ширині)
    crabs += rows * (Math.floor(w / step) + 1);
  });
  const platesUD = Math.ceil(lengthUD / stock);
  const platesCD = Math.ceil(lengthCD / stock);

  out.innerHTML =
    calcRow('UD (направляючий), периметр', `${round2(lengthUD).toFixed(2)} м`) +
    calcRow('UD планок', `${platesUD} шт`) +
    calcRow('CD (несучий) загалом', `${round2(lengthCD).toFixed(2)} м`) +
    calcRow('CD планок', `${platesCD} шт`) +
    calcRow('Прямі підвіси', `${hangers} шт`) +
    calcRow('Краби (зʼєднувачі)', `${crabs} шт`) +
    `<p class="calc-note">Припущення: несучі ряди CD з кроком ${round2(step)} м, ` +
    `підвіси кожні 0.6 м, краби на перетинах сітки (поперечні CD кожні ${round2(step)} м).</p>`;
}

// BLOCK 3: детальна довжина проводки
function renderWireCalc() {
  const out = document.getElementById('wireCalcResults');
  if (!out) return;
  const slack = numVal('wireSlack', 15);

  if (state.wires.length === 0) {
    out.innerHTML = `<p class="calc-empty">Проводки ще немає.</p>`;
    return;
  }

  let html = '';
  let total = 0;
  state.wires.forEach((wire) => {
    const pts = wireRoutePoints(wire);
    if (!pts) return;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
    total += len;
    const from = findNode(wire.from);
    const to = findNode(wire.to);
    const label = `${nodeLabel(from)} → ${nodeLabel(to)}`;
    let route = 'по стіні';
    if (Array.isArray(wire.points) && wire.points.length) route = 'власний маршрут';
    else if (wire.ceiling) route = 'по стелі';
    else if (from && to && (from.wall || 'ceiling') !== (to.wall || 'ceiling')) route = 'через стелю';
    html += calcRow(`${label} (${route})`, `${round2(len).toFixed(2)} м`);
  });

  const withSlack = total * (1 + slack / 100);
  html += calcRow('Сумарна довжина', `${round2(total).toFixed(2)} м`, true);
  html += calcRow(`Сумарна з запасом (${round2(slack)}%)`, `${round2(withSlack).toFixed(2)} м`, true);
  out.innerHTML = html;
}

// Recompute calculations when the calc tab is opened or its inputs change.
const calcTabBtn = document.querySelector('.tab-btn[data-tab="calc"]');
if (calcTabBtn) calcTabBtn.addEventListener('click', renderCalculations);

function onCalcInput() {
  renderCalculations();
  if (state.showDrywall) buildScene(); // sheet size / surface affects the overlay
}
['calcGkStene', 'calcGkCeiling', 'gkSheetW', 'gkSheetH', 'gkWaste',
  'railStep', 'railStock', 'wireSlack',
  'plinthFloor', 'plinthCeiling', 'plinthPiece', 'plinthWaste'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', onCalcInput);
  el.addEventListener('change', onCalcInput);
});

// Drywall layout controls.
els.showDrywall.addEventListener('change', () => {
  state.showDrywall = els.showDrywall.checked;
  buildScene();
});
els.showLeftovers.addEventListener('change', () => {
  state.showLeftovers = els.showLeftovers.checked;
  if (state.showDrywall) buildScene();
});
els.useLeftovers.addEventListener('change', () => {
  state.useLeftovers = els.useLeftovers.checked;
  renderDrywallCalc();
  if (state.showDrywall) buildScene();
});
els.dwOrient.addEventListener('change', () => {
  state.dwOrient = els.dwOrient.value;
  renderDrywallCalc();
  if (state.showDrywall) buildScene();
});
els.dwStagger.addEventListener('change', () => {
  state.dwStagger = els.dwStagger.checked;
  renderDrywallCalc();
  if (state.showDrywall) buildScene();
});

// ---------- Event handlers ----------
function readRoomInputs() {
  const room = activeRoom();
  const w = parseFloat(els.roomWidth.value);
  const l = parseFloat(els.roomLength.value);
  const h = parseFloat(els.roomHeight.value);
  const px = parseFloat(els.roomPosX.value);
  const pz = parseFloat(els.roomPosZ.value);
  const fy = parseFloat(els.roomFloor.value);
  const gs = parseFloat(els.gridStep.value);
  if (w > 0) room.width = w;
  if (l > 0) room.length = l;
  if (h > 0) room.height = h;
  if (isFinite(px)) room.x = px;
  if (isFinite(pz)) room.z = pz;
  if (isFinite(fy)) room.floor = fy;
  if (els.roomName.value.trim()) room.name = els.roomName.value.trim();
  room.thickness = room.thickness || {};
  [['thickN', 'north'], ['thickS', 'south'], ['thickE', 'east'], ['thickW', 'west']].forEach(([id, wall]) => {
    const t = parseFloat(els[id].value);
    if (t > 0) room.thickness[wall] = t;
  });
  if (gs > 0) state.gridStep = gs;
  state.showCeiling = els.showCeiling.checked;
  state.showWallGrid = els.showWallGrid.checked;
  state.showDoorLabels = els.showDoorLabels.checked;
  state.showDims = els.showDims.checked;
  state.showDoorRuler = els.showDoorRuler.checked;
  state.wallOpaque = els.wallOpaque.checked;
}

function onRoomChange() {
  pushHistory();
  readRoomInputs();
  buildScene();
  renderResults();
  renderRoomSelect();
}

['roomWidth', 'roomLength', 'roomHeight', 'roomName', 'roomPosX', 'roomPosZ', 'roomFloor',
  'thickN', 'thickS', 'thickE', 'thickW', 'gridStep'].forEach((id) => {
  els[id].addEventListener('input', onRoomChange);
});

// ---------- Room management ----------
function renderRoomSelect() {
  const curVal = state.activeRoom;
  els.roomSelect.innerHTML = state.rooms
    .map((r) => `<option value="${r.id}"${r.id === curVal ? ' selected' : ''}>${r.name}</option>`)
    .join('');
}

// Load the active room's fields into the "Кімнати" inputs.
function syncRoomInputs() {
  const r = activeRoom();
  if (!r) return;
  els.roomName.value = r.name || '';
  els.roomWidth.value = r.width;
  els.roomLength.value = r.length;
  els.roomHeight.value = r.height;
  els.roomPosX.value = r.x;
  els.roomPosZ.value = r.z;
  els.roomFloor.value = r.floor;
  const th = r.thickness || {};
  els.thickN.value = th.north ?? 0.1;
  els.thickS.value = th.south ?? 0.1;
  els.thickE.value = th.east ?? 0.1;
  els.thickW.value = th.west ?? 0.1;
}

els.roomSelect.addEventListener('change', () => {
  state.activeRoom = els.roomSelect.value;
  syncRoomInputs();
  renderResults();
});

els.addRoomBtn.addEventListener('click', () => {
  pushHistory();
  const seq = state.rooms.length + 1;
  const prev = state.rooms[state.rooms.length - 1];
  const room = defaultRoom(seq);
  // avoid id collisions after deletions
  while (state.rooms.some((r) => r.id === room.id)) room.id = room.id + 'x';
  // place the new room to the right of the previous one, sharing a wall line
  room.x = prev ? prev.x + prev.width / 2 + (prev.thickness?.west ?? 0.1) + room.width / 2 : 0;
  room.z = prev ? prev.z : 0;
  state.rooms.push(room);
  state.activeRoom = room.id;
  renderRoomSelect();
  syncRoomInputs();
  buildScene();
  frameCamera();
  renderResults();
  renderCalculations();
});

els.delRoomBtn.addEventListener('click', () => {
  if (state.rooms.length <= 1) return; // keep at least one room
  const id = state.activeRoom;
  if (!confirm(`Видалити кімнату «${roomById(id).name}» разом з її обʼєктами?`)) return;
  pushHistory();
  const goneIds = new Set();
  state.doors = state.doors.filter((d) => roomOf(d).id !== id);
  state.elements = state.elements.filter((e) => {
    if (roomOf(e).id === id) { goneIds.add(e.id); return false; }
    return true;
  });
  state.lights = state.lights.filter((l) => {
    if (roomOf(l).id === id) { goneIds.add(l.id); return false; }
    return true;
  });
  state.wallObjects = state.wallObjects.filter((o) => roomOf(o).id !== id);
  goneIds.forEach((gid) => dropNodeRefs(gid));
  state.rooms = state.rooms.filter((r) => r.id !== id);
  state.activeRoom = state.rooms[0].id;
  renderRoomSelect();
  syncRoomInputs();
  buildScene();
  frameCamera();
  renderDoorList();
  renderElemList();
  renderLightList();
  renderObjList();
  renderWireOptions();
  renderWireList();
  renderResults();
  renderCalculations();
});
els.showCeiling.addEventListener('change', onRoomChange);
els.showWallGrid.addEventListener('change', onRoomChange);
els.showDoorLabels.addEventListener('change', onRoomChange);
els.showDims.addEventListener('change', onRoomChange);
els.showDoorRuler.addEventListener('change', onRoomChange);
els.wallOpaque.addEventListener('change', onRoomChange);

els.wallColor.addEventListener('input', () => { state.wallColor = hexToNum(els.wallColor.value); buildScene(); });
els.floorColor.addEventListener('input', () => { state.floorColor = hexToNum(els.floorColor.value); buildScene(); });
els.wallImageFile.addEventListener('change', (e) => {
  readImageFile(e.target.files[0], (url) => { state.wallImage = url; buildScene(); });
});
els.wallImageClear.addEventListener('click', () => {
  state.wallImage = null;
  els.wallImageFile.value = '';
  buildScene();
});

// Validate the door form. Returns {wall, offset, width, height} or null (sets error).
function readDoorForm() {
  els.doorError.textContent = '';
  // Validate against the edited door's room, or the active room for new ones.
  const editedDoor = editingId ? state.doors.find((d) => d.id === editingId) : null;
  setRoomCtx(editedDoor ? roomOf(editedDoor) : activeRoom());
  const type = els.doorType.value === 'arch' ? 'arch' : 'door';
  const wall = els.doorWall.value;
  const side = els.doorSide.value === 'right' ? 'right' : 'left';
  const offset = parseFloat(els.doorOffset.value);
  const dWidth = parseFloat(els.doorWidth.value);
  const dHeight = parseFloat(els.doorHeight.value);
  const casing = type === 'arch' ? 0 : (parseFloat(els.doorCasing.value) || 0);
  const radius = type === 'arch' ? (parseFloat(els.doorRadius.value) || 0) : 0;
  const hinge = els.doorHinge.value === 'right' ? 'right' : 'left';
  const openDir = els.doorOpenDir.value === 'out' ? 'out' : 'in';
  const openAngle = Math.max(0, Math.min(120, parseFloat(els.doorOpenAngle.value) || 0));
  const reveal = parseFloat(els.doorReveal.value) || 0;
  const threshold = Math.max(0, parseFloat(els.doorThreshold.value) || 0);
  const inset = Math.max(0, Math.min(parseFloat(els.doorInset.value) || 0, reveal));
  const color = hexToNum(els.doorColor.value);
  const casingColor = hexToNum(els.doorCasingColor.value);
  const image = doorFormImage;

  if (
    !isFinite(offset) || !isFinite(dWidth) || !isFinite(dHeight) ||
    offset < 0 || dWidth <= 0 || dHeight <= 0 || casing < 0 || radius < 0 || reveal < 0
  ) {
    els.doorError.textContent = 'Введіть коректні числові значення для дверей.';
    return null;
  }

  const len = wallLength(wall);
  if (offset + dWidth > len + 1e-9) {
    els.doorError.textContent =
      `Зсув + ширина дверей (${round2(offset + dWidth)} м) перевищує довжину стіни (${round2(len)} м).`;
    return null;
  }
  if (dHeight > cur().height + 1e-9) {
    els.doorError.textContent =
      `Висота дверей (${dHeight} м) перевищує висоту кімнати (${cur().height} м).`;
    return null;
  }
  return { type, wall, side, offset, width: dWidth, height: dHeight, casing, radius, hinge, openDir, openAngle, reveal, threshold, inset, color, casingColor, image, room: cur().id };
}

// Show casing for doors, rounding for arches; opening params only for doors.
function updateDoorFormVisibility() {
  const isArch = els.doorType.value === 'arch';
  els.doorCasingField.hidden = isArch;
  els.doorRadiusField.hidden = !isArch;
  els.doorOpenGroup.hidden = isArch;
}

function startEdit(id) {
  const door = state.doors.find((d) => d.id === id);
  if (!door) return;
  editingId = id;
  isDraftDoor = false;
  snapDoor = { ...door }; // snapshot for revert on "Відхилити"
  els.doorType.value = door.type || 'door';
  els.doorWall.value = door.wall;
  els.doorSide.value = door.side || 'left';
  els.doorOffset.value = door.offset;
  els.doorWidth.value = door.width;
  els.doorHeight.value = door.height;
  els.doorCasing.value = door.casing || 0;
  els.doorRadius.value = door.radius || 0;
  els.doorHinge.value = door.hinge || 'left';
  els.doorOpenDir.value = door.openDir || 'in';
  els.doorOpenAngle.value = door.openAngle ?? 90;
  els.doorReveal.value = door.reveal || 0;
  els.doorThreshold.value = door.threshold || 0;
  els.doorInset.value = door.inset || 0;
  els.doorColor.value = colorHex(door.color ?? 0xff8c00);
  els.doorCasingColor.value = colorHex(door.casingColor ?? door.color ?? 0xff8c00);
  casingColorTouched = door.casingColor != null && door.casingColor !== door.color;
  doorFormImage = door.image || null;
  els.doorImageFile.value = '';
  updateDoorFormVisibility();
  els.doorFormTitle.textContent = 'Редагувати двері';
  els.addDoorBtn.textContent = 'Зберегти зміни';
  els.cancelEditBtn.hidden = false;
  els.doorError.textContent = '';
  renderDoorList();
  els.doorWall.focus();
}

// Leave edit/draft mode without touching state.doors.
function endDoorEdit() {
  editingId = null;
  isDraftDoor = false;
  snapDoor = null;
  els.doorFormTitle.textContent = 'Двері';
  els.addDoorBtn.textContent = 'Додати двері';
  els.cancelEditBtn.hidden = true;
  els.doorError.textContent = '';
  renderDoorList();
}

// Used by import to reset the form completely.
function cancelEdit() {
  doorFormImage = null;
  els.doorImageFile.value = '';
  endDoorEdit();
}

// "Відхилити": drop a fresh draft, or revert an edited door to its snapshot.
els.cancelEditBtn.addEventListener('click', () => {
  if (editingId) {
    if (isDraftDoor) {
      state.doors = state.doors.filter((d) => d.id !== editingId);
    } else if (snapDoor) {
      const i = state.doors.findIndex((d) => d.id === editingId);
      if (i >= 0) state.doors[i] = snapDoor;
    }
  }
  doorFormImage = null;
  els.doorImageFile.value = '';
  endDoorEdit();
  buildScene();
  renderResults();
});

els.addDoorBtn.addEventListener('click', () => {
  const data = readDoorForm();
  if (!data) return;
  if (editingId) {
    const door = state.doors.find((d) => d.id === editingId);
    if (door) Object.assign(door, data);
  } else {
    state.doors.push({ id: 'd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), ...data });
  }
  endDoorEdit(); // keep the item; return to a clean add form
  buildScene();
  renderResults();
});

// Live preview: apply changes while editing, or spin up a draft the moment
// the user starts filling the add form.
function liveDoorUpdate() {
  const data = readDoorForm();
  if (!data) return; // invalid input — keep last valid state, error is shown
  if (!editingId) {
    pushHistory();
    editingId = 'd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    isDraftDoor = true;
    state.doors.push({ id: editingId, ...data });
    els.cancelEditBtn.hidden = false;
  } else {
    const door = state.doors.find((d) => d.id === editingId);
    if (door) Object.assign(door, data);
  }
  buildScene();
  renderResults();
  renderDoorList();
}

['doorType', 'doorWall', 'doorSide', 'doorOffset', 'doorWidth', 'doorHeight',
  'doorCasing', 'doorCasingColor', 'doorRadius', 'doorReveal', 'doorThreshold', 'doorInset', 'doorColor',
  'doorHinge', 'doorOpenDir', 'doorOpenAngle']
  .forEach((id) => {
    els[id].addEventListener('input', liveDoorUpdate);
    els[id].addEventListener('change', liveDoorUpdate);
  });

// Casing colour defaults to the door colour until the user picks its own.
let casingColorTouched = false;
els.doorCasingColor.addEventListener('input', () => { casingColorTouched = true; });
els.doorColor.addEventListener('input', () => {
  if (!casingColorTouched) els.doorCasingColor.value = els.doorColor.value;
});

els.doorType.addEventListener('change', updateDoorFormVisibility);

els.doorImageFile.addEventListener('change', (e) => {
  readImageFile(e.target.files[0], (url) => { doorFormImage = url; liveDoorUpdate(); });
});
els.doorImageClear.addEventListener('click', () => {
  doorFormImage = null;
  els.doorImageFile.value = '';
  liveDoorUpdate();
});

// ---------- Electrical elements UI ----------
function elemLabel(el) {
  return (elementTypes[el.type] || {}).label || el.type;
}

function readElemForm() {
  els.elemError.textContent = '';
  const editedEl = editingElemId ? state.elements.find((e) => e.id === editingElemId) : null;
  setRoomCtx(editedEl ? roomOf(editedEl) : activeRoom());
  const type = els.elemType.value;
  const wall = els.elemWall.value;
  const side = els.elemSide.value === 'right' ? 'right' : 'left';
  const offset = parseFloat(els.elemOffset.value);
  const elevation = parseFloat(els.elemElevation.value);

  if (!elementTypes[type]) {
    els.elemError.textContent = 'Оберіть тип елемента.';
    return null;
  }
  if (!isFinite(offset) || !isFinite(elevation) || offset < 0 || elevation < 0) {
    els.elemError.textContent = 'Введіть коректні числові значення.';
    return null;
  }
  if (offset > wallLength(wall) + 1e-9) {
    els.elemError.textContent =
      `Зсув (${offset} м) перевищує довжину стіни (${round2(wallLength(wall))} м).`;
    return null;
  }
  if (elevation > cur().height + 1e-9) {
    els.elemError.textContent =
      `Висота (${elevation} м) перевищує висоту кімнати (${cur().height} м).`;
    return null;
  }
  const data = { type, wall, side, offset, elevation, room: cur().id };
  if (type === 'panel') {
    const w = parseFloat(els.elemWidth.value);
    const h = parseFloat(els.elemHeight.value);
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
      els.elemError.textContent = 'Введіть коректні розміри щитка.';
      return null;
    }
    data.w = w;
    data.h = h;
  }
  return data;
}

// Show the size inputs only for panels; seed defaults from the element or type.
function syncElemSizeRow(el) {
  const isPanel = els.elemType.value === 'panel';
  els.elemSizeRow.hidden = !isPanel;
  if (isPanel) {
    const [w, h] = el ? elemSize(el) : elementTypes.panel.size;
    els.elemWidth.value = round2(w);
    els.elemHeight.value = round2(h);
  }
}

function startElemEdit(id) {
  const el = state.elements.find((e) => e.id === id);
  if (!el) return;
  editingElemId = id;
  isDraftElem = false;
  snapElem = { ...el };
  els.elemType.value = el.type;
  els.elemWall.value = el.wall;
  els.elemSide.value = el.side || 'left';
  els.elemOffset.value = el.offset;
  els.elemElevation.value = el.elevation;
  syncElemSizeRow(el);
  els.elemFormTitle.textContent = 'Редагувати елемент';
  els.addElemBtn.textContent = 'Зберегти зміни';
  els.cancelElemBtn.hidden = false;
  els.elemError.textContent = '';
  renderElemList();
}

function endElemEdit() {
  editingElemId = null;
  isDraftElem = false;
  snapElem = null;
  els.elemFormTitle.textContent = 'Електрика';
  els.addElemBtn.textContent = 'Додати елемент';
  els.cancelElemBtn.hidden = true;
  els.elemError.textContent = '';
  syncElemSizeRow(null);
  renderElemList();
}

// Kept for import; also used as a plain reset.
function cancelElemEdit() {
  endElemEdit();
}

// "Відхилити": drop a fresh draft or revert an edited element.
els.cancelElemBtn.addEventListener('click', () => {
  if (editingElemId) {
    if (isDraftElem) {
      state.elements = state.elements.filter((e) => e.id !== editingElemId);
    } else if (snapElem) {
      const i = state.elements.findIndex((e) => e.id === editingElemId);
      if (i >= 0) state.elements[i] = snapElem;
    }
  }
  endElemEdit();
  buildScene();
  renderWireOptions();
});

els.addElemBtn.addEventListener('click', () => {
  const data = readElemForm();
  if (!data) return;
  if (editingElemId) {
    const el = state.elements.find((e) => e.id === editingElemId);
    if (el) { delete el.w; delete el.h; Object.assign(el, data); }
  } else {
    state.elements.push({ id: 'e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), ...data });
  }
  endElemEdit();
  buildScene();
  renderWireOptions();
});

// Live preview: edit in place, or create a draft on first change.
function liveElemUpdate() {
  const data = readElemForm();
  if (!data) return;
  if (!editingElemId) {
    pushHistory();
    editingElemId = 'e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    isDraftElem = true;
    state.elements.push({ id: editingElemId, ...data });
    els.cancelElemBtn.hidden = false;
  } else {
    const el = state.elements.find((e) => e.id === editingElemId);
    if (el) { delete el.w; delete el.h; Object.assign(el, data); }
  }
  buildScene();
  renderElemList();
  renderWireOptions();
}

// Toggle the panel-size row when the type changes (before live update runs).
els.elemType.addEventListener('change', () => {
  const el = editingElemId ? state.elements.find((e) => e.id === editingElemId) : null;
  syncElemSizeRow(el);
});

['elemType', 'elemWall', 'elemSide', 'elemWidth', 'elemHeight', 'elemOffset', 'elemElevation']
  .forEach((id) => {
    els[id].addEventListener('input', liveElemUpdate);
    els[id].addEventListener('change', liveElemUpdate);
  });

// Drop wires whose endpoint is this node, and via-points linking to it.
function dropNodeRefs(id) {
  state.wires = state.wires.filter((wr) => wr.from !== id && wr.to !== id);
  state.wires.forEach((wr) => {
    if (Array.isArray(wr.points)) wr.points = wr.points.filter((p) => p.node !== id);
  });
}

function removeElement(id) {
  pushHistory();
  if (id === editingElemId) cancelElemEdit();
  state.elements = state.elements.filter((e) => e.id !== id);
  dropNodeRefs(id);
  buildScene();
  renderElemList();
  renderWireOptions();
  renderWireList();
}

function renderElemList() {
  els.elemList.innerHTML = '';
  if (state.elements.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Елементи ще не додані.';
    els.elemList.appendChild(li);
    return;
  }
  state.elements.forEach((el) => {
    const li = document.createElement('li');
    if (el.id === editingElemId) li.className = 'editing';

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colorHex(elementTypes[el.type].color);

    const info = document.createElement('span');
    info.className = 'door-info';
    const sideLabel = el.side === 'right' ? 'справа' : 'зліва';
    const sizeLabel = el.type === 'panel'
      ? (() => { const [w, h] = elemSize(el); return ` · ${round2(w)}×${round2(h)} м`; })() : '';
    const roomLabel = state.rooms.length > 1 ? `${roomOf(el).name} · ` : '';
    info.innerHTML =
      `<strong>${roomLabel}${elemLabel(el)} — ${wallNames[el.wall]}</strong><br>` +
      `зсув ${el.offset} м (${sideLabel}) · висота ${el.elevation} м${sizeLabel}`;

    const actions = document.createElement('span');
    actions.className = 'actions';

    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.textContent = 'Редагувати';
    edit.addEventListener('click', () => startElemEdit(el.id));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Видалити';
    del.addEventListener('click', () => removeElement(el.id));

    actions.appendChild(edit);
    actions.appendChild(del);
    li.appendChild(swatch);
    li.appendChild(info);
    li.appendChild(actions);
    els.elemList.appendChild(li);
  });
}

// ---------- Wiring UI ----------
function renderWireOptions() {
  const many = state.rooms.length > 1;
  const rn = (o) => (many ? `${roomOf(o).name} · ` : '');
  const elemOpts = state.elements
    .map((e) => `<option value="${e.id}">${rn(e)}${elemLabel(e)} — ${wallNames[e.wall]} (${e.offset}м)</option>`)
    .join('');
  const lightOpts = state.lights
    .map((l) => `<option value="${l.id}">${rn(l)}Світильник — ${l.mount === 'wall' ? wallNames[l.wall] : 'стеля'}</option>`)
    .join('');
  const placeholder = '<option value="">—</option>';
  els.wireFrom.innerHTML = placeholder + elemOpts + lightOpts;
  els.wireTo.innerHTML = placeholder + elemOpts + lightOpts;
}

const cableLabels = { power: 'Мережевий', utp: 'Вита пара', fiber: 'Оптоволокно' };

function readWireType() {
  const cable = ['power', 'utp', 'fiber'].includes(els.wireCable.value) ? els.wireCable.value : 'power';
  const cores = Math.max(1, Math.round(parseFloat(els.wireCores.value) || 1));
  const diam = Math.max(0.1, parseFloat(els.wireDiam.value) || 1);
  return { cable, cores, diam };
}

els.addWireBtn.addEventListener('click', () => {
  els.wireError.textContent = '';
  pushHistory();
  const from = els.wireFrom.value;
  const to = els.wireTo.value;
  if (!from || !to) {
    els.wireError.textContent = 'Оберіть два елементи.';
    return;
  }
  if (from === to) {
    els.wireError.textContent = 'Оберіть два різні елементи.';
    return;
  }
  if (state.wires.some((wr) => (wr.from === from && wr.to === to) || (wr.from === to && wr.to === from))) {
    els.wireError.textContent = 'Такий провід вже існує.';
    return;
  }
  state.wires.push({
    id: 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    from, to, ceiling: els.wireCeiling.checked, lane: 0, ...readWireType(),
  });
  buildScene();
  renderWireList();
});

function renderWireList() {
  els.wireList.innerHTML = '';
  if (state.wires.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Проводів ще немає.';
    els.wireList.appendChild(li);
    return;
  }
  state.wires.forEach((wire) => {
    const from = findNode(wire.from);
    const to = findNode(wire.to);
    const li = document.createElement('li');

    const info = document.createElement('span');
    info.className = 'door-info';
    const route = wire.ceiling ? ' <span style="color:#38bdf8">(по стелі)</span>' : '';
    const cable = cableLabels[wire.cable] || 'Мережевий';
    const via = (Array.isArray(wire.points) && wire.points.some((p) => p.node))
      ? ` · через ${wire.points.filter((p) => p.node).length} прилад(ів)` : '';
    const spec = `${cable} · ${wire.cores || 1} жил · ⌀${round2(wire.diam || 1)} мм`
      + (wire.lane ? ` · паралель #${wire.lane}` : '') + via;
    info.innerHTML = from && to
      ? `<strong>${nodeLabel(from)}</strong> → <strong>${nodeLabel(to)}</strong>${route}<br>${spec}`
      : '<em>невідомі елементи</em>';

    const actions = document.createElement('span');
    actions.className = 'actions';
    const par = document.createElement('button');
    par.className = 'edit';
    par.textContent = 'Паралельний';
    par.addEventListener('click', () => {
      pushHistory();
      const lane = Math.max(0, ...state.wires
        .filter((w) => w.from === wire.from && w.to === wire.to).map((w) => w.lane || 0)) + 1;
      state.wires.push({
        id: 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        from: wire.from, to: wire.to, ceiling: wire.ceiling,
        cable: wire.cable, cores: wire.cores, diam: wire.diam, lane,
      });
      buildScene();
      renderWireList();
    });
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Видалити';
    del.addEventListener('click', () => {
      pushHistory();
      state.wires = state.wires.filter((wr) => wr.id !== wire.id);
      buildScene();
      renderWireList();
    });
    actions.appendChild(par);
    actions.appendChild(del);

    li.appendChild(info);
    li.appendChild(actions);
    els.wireList.appendChild(li);
  });
}

// ---------- Ceiling lights UI ----------
function updateLightFormVisibility() {
  const wall = els.lightMount.value === 'wall';
  els.lightWallFields.hidden = !wall;
  els.lightCeilingFields.hidden = wall;
}
els.lightMount.addEventListener('change', updateLightFormVisibility);

els.addLightBtn.addEventListener('click', () => {
  els.lightError.textContent = '';
  pushHistory();
  setRoomCtx(activeRoom());
  const room = cur().id;
  const id = 'lt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  if (els.lightMount.value === 'wall') {
    const wall = els.lightWall.value;
    const side = els.lightSide.value === 'right' ? 'right' : 'left';
    const offset = parseFloat(els.lightOffset.value);
    const elevation = parseFloat(els.lightElevation.value);
    if (!isFinite(offset) || !isFinite(elevation) || offset < 0 || elevation < 0) {
      els.lightError.textContent = 'Введіть коректні значення.';
      return;
    }
    if (offset > wallLength(wall) + 1e-9 || elevation > cur().height + 1e-9) {
      els.lightError.textContent = 'Значення виходять за межі стіни.';
      return;
    }
    state.lights.push({ id, mount: 'wall', wall, side, offset, elevation, room });
  } else {
    const x = parseFloat(els.lightX.value);
    const z = parseFloat(els.lightZ.value);
    if (!isFinite(x) || !isFinite(z) || x < 0 || z < 0) {
      els.lightError.textContent = 'Введіть коректні координати.';
      return;
    }
    if (x > cur().width + 1e-9 || z > cur().length + 1e-9) {
      els.lightError.textContent =
        `Координати виходять за межі кімнати (${round2(cur().width)}×${round2(cur().length)} м).`;
      return;
    }
    state.lights.push({ id, mount: 'ceiling', x, z, room });
  }
  buildScene();
  renderLightList();
  renderWireOptions(); // lights are wire endpoints too
});

function renderLightList() {
  els.lightList.innerHTML = '';
  if (state.lights.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Світильників ще немає.';
    els.lightList.appendChild(li);
    return;
  }
  state.lights.forEach((light) => {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.className = 'door-info';
    info.innerHTML = light.mount === 'wall'
      ? `<strong>Світильник — ${wallNames[light.wall]}</strong><br>зсув ${round2(light.offset)} м · висота ${round2(light.elevation)} м`
      : `<strong>Світильник — стеля</strong><br>X ${round2(light.x)} м · Z ${round2(light.z)} м`;
    const actions = document.createElement('span');
    actions.className = 'actions';
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Видалити';
    del.addEventListener('click', () => {
      pushHistory();
      state.lights = state.lights.filter((lt) => lt.id !== light.id);
      dropNodeRefs(light.id);
      buildScene();
      renderLightList();
      renderWireOptions();
      renderWireList();
    });
    actions.appendChild(del);
    li.appendChild(info);
    li.appendChild(actions);
    els.lightList.appendChild(li);
  });
}

// ---------- Wall objects (pictures / mirrors) UI ----------
const objTypeLabels = { picture: 'Картина', mirror: 'Дзеркало' };

function updateObjFormVisibility() {
  els.objImageField.hidden = els.objType.value !== 'picture';
}

function readObjForm() {
  els.objError.textContent = '';
  const editedObj = editingObjId ? state.wallObjects.find((o) => o.id === editingObjId) : null;
  setRoomCtx(editedObj ? roomOf(editedObj) : activeRoom());
  const type = els.objType.value === 'mirror' ? 'mirror' : 'picture';
  const wall = els.objWall.value;
  const side = els.objSide.value === 'right' ? 'right' : 'left';
  const offset = parseFloat(els.objOffset.value);
  const elevation = parseFloat(els.objElevation.value);
  const width = parseFloat(els.objWidth.value);
  const height = parseFloat(els.objHeight.value);
  const color = hexToNum(els.objColor.value);
  const image = type === 'picture' ? objFormImage : null;

  if (![offset, elevation, width, height].every(isFinite) || offset < 0 || elevation < 0 || width <= 0 || height <= 0) {
    els.objError.textContent = 'Введіть коректні числові значення.';
    return null;
  }
  if (offset > wallLength(wall) + 1e-9) {
    els.objError.textContent = `Зсув перевищує довжину стіни (${round2(wallLength(wall))} м).`;
    return null;
  }
  if (elevation + height / 2 > cur().height + 1e-9) {
    els.objError.textContent = 'Предмет виходить за верх стіни.';
    return null;
  }
  return { type, wall, side, offset, elevation, width, height, color, image, room: cur().id };
}

function startObjEdit(id) {
  const obj = state.wallObjects.find((o) => o.id === id);
  if (!obj) return;
  editingObjId = id;
  isDraftObj = false;
  snapObj = { ...obj };
  els.objType.value = obj.type;
  els.objWall.value = obj.wall;
  els.objSide.value = obj.side || 'left';
  els.objOffset.value = obj.offset;
  els.objElevation.value = obj.elevation;
  els.objWidth.value = obj.width;
  els.objHeight.value = obj.height;
  els.objColor.value = colorHex(obj.color ?? 0x8b5a2b);
  objFormImage = obj.image || null;
  els.objImageFile.value = '';
  updateObjFormVisibility();
  els.objFormTitle.textContent = 'Редагувати предмет';
  els.addObjBtn.textContent = 'Зберегти зміни';
  els.cancelObjBtn.hidden = false;
  els.objError.textContent = '';
  renderObjList();
}

function endObjEdit() {
  editingObjId = null;
  isDraftObj = false;
  snapObj = null;
  els.objFormTitle.textContent = 'Предмети на стіні';
  els.addObjBtn.textContent = 'Додати предмет';
  els.cancelObjBtn.hidden = true;
  els.objError.textContent = '';
  renderObjList();
}

// Kept for import; also a plain reset.
function cancelObjEdit() {
  objFormImage = null;
  els.objImageFile.value = '';
  endObjEdit();
}

function liveObjUpdate() {
  const data = readObjForm();
  if (!data) return;
  if (!editingObjId) {
    pushHistory();
    editingObjId = 'o-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    isDraftObj = true;
    state.wallObjects.push({ id: editingObjId, ...data });
    els.cancelObjBtn.hidden = false;
  } else {
    const obj = state.wallObjects.find((o) => o.id === editingObjId);
    if (obj) Object.assign(obj, data);
  }
  buildScene();
  renderObjList();
}

// "Відхилити": drop a fresh draft or revert an edited object.
els.cancelObjBtn.addEventListener('click', () => {
  if (editingObjId) {
    if (isDraftObj) {
      state.wallObjects = state.wallObjects.filter((o) => o.id !== editingObjId);
    } else if (snapObj) {
      const i = state.wallObjects.findIndex((o) => o.id === editingObjId);
      if (i >= 0) state.wallObjects[i] = snapObj;
    }
  }
  objFormImage = null;
  els.objImageFile.value = '';
  endObjEdit();
  buildScene();
});
els.objType.addEventListener('change', updateObjFormVisibility);
els.addObjBtn.addEventListener('click', () => {
  const data = readObjForm();
  if (!data) return;
  if (editingObjId) {
    const obj = state.wallObjects.find((o) => o.id === editingObjId);
    if (obj) Object.assign(obj, data);
  } else {
    state.wallObjects.push({ id: 'o-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), ...data });
  }
  endObjEdit();
  buildScene();
});

['objType', 'objWall', 'objSide', 'objOffset', 'objElevation', 'objWidth', 'objHeight', 'objColor']
  .forEach((id) => {
    els[id].addEventListener('input', liveObjUpdate);
    els[id].addEventListener('change', liveObjUpdate);
  });

els.objImageFile.addEventListener('change', (e) => {
  readImageFile(e.target.files[0], (url) => { objFormImage = url; liveObjUpdate(); });
});
els.objImageClear.addEventListener('click', () => {
  objFormImage = null;
  els.objImageFile.value = '';
  liveObjUpdate();
});

function removeObj(id) {
  pushHistory();
  if (id === editingObjId) cancelObjEdit();
  state.wallObjects = state.wallObjects.filter((o) => o.id !== id);
  buildScene();
  renderObjList();
}

function renderObjList() {
  els.objList.innerHTML = '';
  if (state.wallObjects.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Предметів ще немає.';
    els.objList.appendChild(li);
    return;
  }
  state.wallObjects.forEach((obj) => {
    const li = document.createElement('li');
    if (obj.id === editingObjId) li.className = 'editing';

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colorHex(obj.color);

    const info = document.createElement('span');
    info.className = 'door-info';
    const img = obj.type === 'picture' && obj.image ? ' · зображення' : '';
    info.innerHTML =
      `<strong>${objTypeLabels[obj.type]} — ${wallNames[obj.wall]}</strong><br>` +
      `зсув ${obj.offset} м · висота ${obj.elevation} м · ${obj.width}×${obj.height} м${img}`;

    const actions = document.createElement('span');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.textContent = 'Редагувати';
    edit.addEventListener('click', () => startObjEdit(obj.id));
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Видалити';
    del.addEventListener('click', () => removeObj(obj.id));
    actions.appendChild(edit);
    actions.appendChild(del);

    li.appendChild(swatch);
    li.appendChild(info);
    li.appendChild(actions);
    els.objList.appendChild(li);
  });
}

// ---------- Save / Import ----------
function syncInputsFromState() {
  renderRoomSelect();
  syncRoomInputs();
  els.gridStep.value = state.gridStep;
  els.showCeiling.checked = state.showCeiling;
  els.showWallGrid.checked = state.showWallGrid;
  els.showDoorLabels.checked = state.showDoorLabels;
  els.showDims.checked = state.showDims;
  els.showDoorRuler.checked = state.showDoorRuler;
  els.showDrywall.checked = state.showDrywall;
  els.showLeftovers.checked = state.showLeftovers;
  els.useLeftovers.checked = state.useLeftovers;
  els.dwOrient.value = state.dwOrient;
  els.dwStagger.checked = state.dwStagger;
  els.wallColor.value = colorHex(state.wallColor);
  els.wallOpaque.checked = state.wallOpaque;
  els.floorColor.value = colorHex(state.floorColor);
}

function serializeState() {
  return {
    app: 'room-3d',
    version: 2,
    rooms: state.rooms.map((r) => ({
      id: r.id, name: r.name, x: r.x, z: r.z,
      width: r.width, length: r.length, height: r.height, floor: r.floor,
      thickness: { ...(r.thickness || {}) },
    })),
    activeRoom: state.activeRoom,
    room: {
      showCeiling: state.showCeiling,
      gridStep: state.gridStep,
      showWallGrid: state.showWallGrid,
      showDoorLabels: state.showDoorLabels,
      showDims: state.showDims,
      showDoorRuler: state.showDoorRuler,
      showDrywall: state.showDrywall,
      showLeftovers: state.showLeftovers,
      useLeftovers: state.useLeftovers,
      dwOrient: state.dwOrient,
      dwStagger: state.dwStagger,
      wallColor: state.wallColor,
      wallOpaque: state.wallOpaque,
      wallImage: state.wallImage,
      floorColor: state.floorColor,
    },
    doors: state.doors.map((d) => ({
      type: d.type || 'door',
      room: roomOf(d).id,
      wall: d.wall,
      side: d.side || 'left',
      offset: d.offset,
      width: d.width,
      height: d.height,
      casing: d.casing || 0,
      radius: d.radius || 0,
      hinge: d.hinge || 'left',
      openDir: d.openDir || 'in',
      openAngle: d.openAngle ?? 90,
      reveal: d.reveal || 0,
      threshold: d.threshold || 0,
      inset: d.inset || 0,
      color: d.color ?? 0xff8c00,
      casingColor: d.casingColor ?? (d.color ?? 0xff8c00),
      image: d.image || null,
    })),
    elements: state.elements.map((e) => ({
      id: e.id,
      type: e.type,
      room: roomOf(e).id,
      wall: e.wall,
      side: e.side || 'left',
      offset: e.offset,
      elevation: e.elevation,
      ...(e.type === 'panel' && isFinite(e.w) ? { w: e.w, h: e.h } : {}),
    })),
    wires: state.wires.map((wr) => ({
      from: wr.from, to: wr.to, ceiling: !!wr.ceiling,
      cable: wr.cable || 'power', cores: wr.cores || 1, diam: wr.diam || 1, lane: wr.lane || 0,
      points: Array.isArray(wr.points)
        ? wr.points.map((p) => (p.node ? { node: p.node } : { x: p.x, y: p.y, z: p.z })) : [],
    })),
    lights: state.lights.map((lt) => (lt.mount === 'wall'
      ? { id: lt.id, mount: 'wall', room: roomOf(lt).id, wall: lt.wall, side: lt.side || 'left', offset: lt.offset, elevation: lt.elevation }
      : { id: lt.id, mount: 'ceiling', room: roomOf(lt).id, x: lt.x, z: lt.z })),
    wallObjects: state.wallObjects.map((o) => ({
      type: o.type, room: roomOf(o).id, wall: o.wall, side: o.side || 'left',
      offset: o.offset, elevation: o.elevation, width: o.width, height: o.height,
      color: o.color, image: o.image || null,
    })),
  };
}

function ioMessage(text, ok = false) {
  els.ioMsg.textContent = text;
  els.ioMsg.className = ok ? 'hint ok' : 'hint';
}

function currentJson() {
  return JSON.stringify(serializeState(), null, 2);
}

function suggestedFileName() {
  return `kimnata-${new Date().toISOString().slice(0, 10)}.json`;
}

function downloadJson() {
  const data = currentJson();
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function writeToHandle(handle) {
  const writable = await handle.createWritable();
  await writable.write(currentJson());
  await writable.close();
}

async function pickAndSave() {
  const handle = await window.showSaveFilePicker({
    suggestedName: suggestedFileName(),
    types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
  });
  await writeToHandle(handle);
  fileHandle = handle;
}

// Reset the live state back to the empty defaults.
function resetState() {
  Object.assign(state, JSON.parse(JSON.stringify(INITIAL)));
}

// Start a fresh project: reset, refresh all UI, download the empty template,
// then open the constructor.
function newProject() {
  const hasContent = state.doors.length || state.elements.length ||
    state.wires.length || state.lights.length || state.wallObjects.length;
  if (hasProject && hasContent &&
      !confirm('Створити новий проект? Незбережені зміни буде втрачено.')) return;

  cancelEdit();
  cancelElemEdit();
  cancelObjEdit();
  resetState();
  fileHandle = null;
  editingId = editingElemId = editingObjId = null;

  syncInputsFromState();
  buildScene();
  frameCamera();
  resize();
  renderDoorList();
  renderResults();
  renderElemList();
  renderWireOptions();
  renderWireList();
  renderLightList();
  renderObjList();
  renderCalculations();

  setHasProject(true);
  downloadJson(); // auto-save the empty template
  switchTab('constructor');
  ioMessage('Новий проект створено, шаблон завантажено.', true);
}

els.newProjectBtn.addEventListener('click', newProject);

els.saveBtn.addEventListener('click', async () => {
  if (window.showSaveFilePicker) {
    try {
      await pickAndSave();
      ioMessage('Дані збережено у файл.', true);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      ioMessage('Помилка збереження: ' + err.message, false);
    }
    return;
  }
  downloadJson();
  ioMessage('Дані збережено у файл.', true);
});

els.overwriteBtn.addEventListener('click', async () => {
  if (!window.showSaveFilePicker) {
    downloadJson();
    ioMessage('Перезапис на місці потребує браузера на основі Chromium. Файл завантажено як новий.', false);
    return;
  }
  try {
    if (fileHandle) {
      await writeToHandle(fileHandle);
      ioMessage('Відкритий файл перезаписано.', true);
    } else {
      await pickAndSave();
      ioMessage('Дані збережено у файл.', true);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    ioMessage('Помилка перезапису: ' + err.message, false);
  }
});

els.importBtn.addEventListener('click', async () => {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const file = await handle.getFile();
      const text = await file.text();
      applyImported(JSON.parse(text));
      fileHandle = handle;
      ioMessage('Дані успішно імпортовано.', true);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      ioMessage('Помилка імпорту: ' + err.message, false);
    }
    return;
  }
  els.importFile.click();
});

els.importFile.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyImported(JSON.parse(reader.result));
      ioMessage('Дані успішно імпортовано.', true);
    } catch (err) {
      ioMessage('Помилка імпорту: ' + err.message, false);
    }
    els.importFile.value = ''; // allow re-importing the same file
  };
  reader.readAsText(file);
});

function applyImported(data, opts = {}) {
  const jump = opts.jump !== false;
  const validWalls = ['north', 'south', 'east', 'west'];
  if (!data || typeof data !== 'object' || !data.room || !Array.isArray(data.doors)) {
    throw new Error('невірний формат файлу');
  }
  const r = data.room;
  const num = (v, def) => (isFinite(parseFloat(v)) && parseFloat(v) > 0 ? parseFloat(v) : def);

  cancelEdit();
  cancelElemEdit();

  // Rooms: v2 carries an array; v1 files described a single room inline.
  const rooms = [];
  if (Array.isArray(data.rooms) && data.rooms.length) {
    data.rooms.forEach((rr, i) => {
      const base = defaultRoom(i + 1);
      rooms.push({
        ...base,
        id: typeof rr.id === 'string' && rr.id ? rr.id : base.id,
        name: typeof rr.name === 'string' && rr.name ? rr.name : base.name,
        x: isFinite(parseFloat(rr.x)) ? parseFloat(rr.x) : 0,
        z: isFinite(parseFloat(rr.z)) ? parseFloat(rr.z) : 0,
        width: num(rr.width, base.width),
        length: num(rr.length, base.length),
        height: num(rr.height, base.height),
        floor: isFinite(parseFloat(rr.floor)) ? parseFloat(rr.floor) : 0,
        thickness: {
          north: num(rr.thickness && rr.thickness.north, 0.1),
          south: num(rr.thickness && rr.thickness.south, 0.1),
          east: num(rr.thickness && rr.thickness.east, 0.1),
          west: num(rr.thickness && rr.thickness.west, 0.1),
        },
      });
    });
  } else {
    const one = defaultRoom(1);
    one.width = num(r.width, one.width);
    one.length = num(r.length, one.length);
    one.height = num(r.height, one.height);
    rooms.push(one);
  }
  state.rooms = rooms;
  state.activeRoom = rooms.some((x) => x.id === data.activeRoom) ? data.activeRoom : rooms[0].id;
  const roomIdOr = (id) => (rooms.some((x) => x.id === id) ? id : rooms[0].id);

  state.gridStep = num(r.gridStep, state.gridStep);
  state.showCeiling = !!r.showCeiling;
  state.showWallGrid = r.showWallGrid !== false;
  state.showDoorLabels = !!r.showDoorLabels;
  state.showDims = !!r.showDims;
  state.showDoorRuler = !!r.showDoorRuler;
  state.showDrywall = !!r.showDrywall;
  state.showLeftovers = r.showLeftovers !== false;
  state.useLeftovers = r.useLeftovers !== false;
  state.dwOrient = ['auto', 'h', 'v', 'econ'].includes(r.dwOrient) ? r.dwOrient : 'auto';
  state.dwStagger = r.dwStagger !== false;
  state.wallColor = Number.isFinite(r.wallColor) ? r.wallColor : state.wallColor;
  state.wallOpaque = !!r.wallOpaque;
  state.wallImage = r.wallImage || null;
  state.floorColor = Number.isFinite(r.floorColor) ? r.floorColor : state.floorColor;

  state.doors = [];
  doorSeq = 0;
  data.doors.forEach((d) => {
    if (!validWalls.includes(d.wall)) return;
    const offset = parseFloat(d.offset);
    const width = parseFloat(d.width);
    const height = parseFloat(d.height);
    const casing = parseFloat(d.casing) || 0;
    if (![offset, width, height].every(isFinite) || width <= 0 || height <= 0 || offset < 0) return;
    state.doors.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      type: d.type === 'arch' ? 'arch' : 'door',
      room: roomIdOr(d.room),
      wall: d.wall,
      side: d.side === 'right' ? 'right' : 'left',
      offset,
      width,
      height,
      casing: casing >= 0 ? casing : 0,
      radius: Math.max(0, parseFloat(d.radius) || 0),
      hinge: d.hinge === 'right' ? 'right' : 'left',
      openDir: d.openDir === 'out' ? 'out' : 'in',
      openAngle: Math.max(0, Math.min(120, isFinite(parseFloat(d.openAngle)) ? parseFloat(d.openAngle) : 90)),
      reveal: Math.max(0, parseFloat(d.reveal) || 0),
      threshold: Math.max(0, parseFloat(d.threshold) || 0),
      inset: Math.max(0, parseFloat(d.inset) || 0),
      color: Number.isFinite(d.color) ? d.color : doorColors[doorSeq % doorColors.length],
      casingColor: Number.isFinite(d.casingColor) ? d.casingColor : undefined,
      image: d.image || null,
    });
    doorSeq++;
  });

  // Electrical elements (preserve ids so wires keep referencing them)
  state.elements = [];
  (Array.isArray(data.elements) ? data.elements : []).forEach((e) => {
    if (!elementTypes[e.type] || !validWalls.includes(e.wall)) return;
    const offset = parseFloat(e.offset);
    const elevation = parseFloat(e.elevation);
    if (![offset, elevation].every(isFinite) || offset < 0 || elevation < 0) return;
    const rec = {
      id: e.id || 'e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      type: e.type,
      room: roomIdOr(e.room),
      wall: e.wall,
      side: e.side === 'right' ? 'right' : 'left',
      offset,
      elevation,
    };
    if (e.type === 'panel') {
      const w = parseFloat(e.w);
      const h = parseFloat(e.h);
      if (isFinite(w) && w > 0 && isFinite(h) && h > 0) { rec.w = w; rec.h = h; }
    }
    state.elements.push(rec);
  });

  // Wires (keep only those linking existing elements)
  const ids = new Set(state.elements.map((e) => e.id));
  (Array.isArray(data.lights) ? data.lights : []).forEach((lt) => {
    if (typeof lt.id === 'string' && lt.id.startsWith('lt-')) ids.add(lt.id);
  });
  state.wires = [];
  (Array.isArray(data.wires) ? data.wires : []).forEach((wr) => {
    if (ids.has(wr.from) && ids.has(wr.to) && wr.from !== wr.to) {
      const points = Array.isArray(wr.points)
        ? wr.points.map((p) => (p.node ? { node: p.node }
          : ([p.x, p.y, p.z].every((v) => isFinite(parseFloat(v))) ? { x: +p.x, y: +p.y, z: +p.z } : null)))
          .filter(Boolean)
        : [];
      state.wires.push({
        id: 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        from: wr.from, to: wr.to, ceiling: !!wr.ceiling,
        cable: ['power', 'utp', 'fiber'].includes(wr.cable) ? wr.cable : 'power',
        cores: Math.max(1, Math.round(parseFloat(wr.cores) || 1)),
        diam: Math.max(0.1, parseFloat(wr.diam) || 1),
        lane: Math.max(0, Math.round(parseFloat(wr.lane) || 0)),
        points,
      });
    }
  });

  // Lights (ceiling or wall)
  state.lights = [];
  const validWallsL = ['north', 'south', 'east', 'west'];
  (Array.isArray(data.lights) ? data.lights : []).forEach((lt) => {
    const id = (typeof lt.id === 'string' && lt.id.startsWith('lt-')) ? lt.id
      : 'lt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    if (lt.mount === 'wall' && validWallsL.includes(lt.wall)) {
      const offset = parseFloat(lt.offset);
      const elevation = parseFloat(lt.elevation);
      if (![offset, elevation].every(isFinite) || offset < 0 || elevation < 0) return;
      state.lights.push({ id, mount: 'wall', room: roomIdOr(lt.room), wall: lt.wall, side: lt.side === 'right' ? 'right' : 'left', offset, elevation });
    } else {
      const x = parseFloat(lt.x);
      const z = parseFloat(lt.z);
      if (!isFinite(x) || !isFinite(z) || x < 0 || z < 0) return;
      state.lights.push({ id, mount: 'ceiling', room: roomIdOr(lt.room), x, z });
    }
  });

  // Wall objects (pictures / mirrors)
  state.wallObjects = [];
  const objTypes = ['picture', 'mirror'];
  (Array.isArray(data.wallObjects) ? data.wallObjects : []).forEach((o) => {
    if (!objTypes.includes(o.type) || !validWalls.includes(o.wall)) return;
    const offset = parseFloat(o.offset), elevation = parseFloat(o.elevation);
    const width = parseFloat(o.width), height = parseFloat(o.height);
    if (![offset, elevation, width, height].every(isFinite) || width <= 0 || height <= 0) return;
    state.wallObjects.push({
      id: 'o-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      type: o.type, room: roomIdOr(o.room), wall: o.wall, side: o.side === 'right' ? 'right' : 'left',
      offset, elevation, width, height,
      color: Number.isFinite(o.color) ? o.color : 0x8b5a2b,
      image: o.image || null,
    });
  });

  cancelObjEdit();
  syncInputsFromState();
  buildScene();
  if (jump) frameCamera();
  renderDoorList();
  renderResults();
  renderElemList();
  renderWireOptions();
  renderWireList();
  renderLightList();
  renderObjList();
  renderCalculations();
  if (jump) {
    setHasProject(true); // a real import opens a project → unlock the other tabs
    switchTab('constructor');
  }
}

// ---------- Init ----------
function init() {
  // No project until the user creates or imports one — lock the other tabs.
  setHasProject(false);
  // Start with an empty room — no default doors or electrical elements
  syncInputsFromState();
  updateDoorFormVisibility();
  updateObjFormVisibility();
  updateLightFormVisibility();
  buildScene();
  frameCamera();
  resize();
  renderDoorList();
  renderResults();
  renderElemList();
  renderWireOptions();
  renderWireList();
  renderLightList();
  renderObjList();
  renderCalculations();
  animate();
}

// ---------- Interaction: drag to move / drag to wire ----------
let interactionMode = 'orbit'; // 'orbit' | 'move' | 'wire'
let lastPointClick = null; // { id, index, t } — for manual dbl-click on control points
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag = null;       // active move-drag { kind, id, wall, plane }
let wireDrag = null;   // active wire-drag { from }
let tempWireLine = null;
let rebuildQueued = false;

const modeHints = {
  orbit: 'Обертання, масштаб і панорама мишею.',
  move: 'Тягніть обʼєкт, щоб перемістити. Порожнє місце — обертання камери.',
  wire: 'Тягніть від розетки/вимикача/щитка до іншого — зʼявиться провід.',
};

function setMode(m) {
  interactionMode = m;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  const hint = document.getElementById('modeHint');
  if (hint) hint.textContent = modeHints[m] || '';
  renderer.domElement.style.cursor = m === 'orbit' ? '' : 'crosshair';
}
document.querySelectorAll('.mode-btn').forEach((b) => {
  b.addEventListener('click', () => setMode(b.dataset.mode));
});

function setNdc(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((cx - r.left) / r.width) * 2 - 1;
  ndc.y = -((cy - r.top) / r.height) * 2 + 1;
}

// Raycast into the scene and return the tagged object under the cursor.
function pickObject(cx, cy) {
  setNdc(cx, cy);
  raycaster.setFromCamera(ndc, camera);
  raycaster.params.Line.threshold = 0.12;
  const hits = raycaster.intersectObjects(roomGroup.children, true);
  const tagged = [];
  for (const h of hits) {
    let o = h.object;
    while (o && !(o.userData && o.userData.kind)) o = o.parent;
    if (o && o.userData && o.userData.kind && o.userData.id) {
      tagged.push({ ...o.userData, point: h.point, dist: h.distance });
    }
  }
  if (!tagged.length) return null;
  // The line threshold fattens wires, so a cable hugging a device wins the
  // raycast even when the cursor is on the device. Prefer a nearby non-line
  // hit so drops land on devices/handles, not on the cable passing by them.
  if (tagged[0].kind === 'wireline') {
    const solid = tagged.find((t) => t.kind !== 'wireline' && t.dist - tagged[0].dist < 0.5);
    if (solid) return solid;
  }
  return tagged[0];
}

const draggableKind = (k) => k === 'element' || k === 'light' || k === 'door' || k === 'wallobj';

// Nearest room surface (wall or ceiling) under the cursor, via plane math so
// objects can be dragged from one wall to another.
function pickSurface(cx, cy) {
  setNdc(cx, cy);
  raycaster.setFromCamera(ndc, camera);
  const ray = raycaster.ray;
  const cands = [];
  state.rooms.forEach((room) => {
    setRoomCtx(room);
    const { width: w, length: l, height: h, floor: fy } = room;
    ['north', 'south', 'east', 'west'].forEach((wall) => {
      const b = wallBasis(wall);
      const corner = wallAlongPoint(wall, 0);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        new THREE.Vector3(b.ex.x, 0, b.ex.z), new THREE.Vector3(corner.x, 0, corner.z));
      const hit = new THREE.Vector3();
      if (!ray.intersectPlane(plane, hit)) return;
      const off = (hit.x - corner.x) * b.tan.x + (hit.z - corner.z) * b.tan.z;
      if (off < -0.02 || off > wallLength(wall) + 0.02) return;
      if (hit.y < fy - 0.02 || hit.y > fy + h + 0.02) return;
      cands.push({ surface: 'wall', wall, room, point: hit, dist: ray.origin.distanceTo(hit) });
    });
    const cplane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(fy + h));
    const chit = new THREE.Vector3();
    if (ray.intersectPlane(cplane, chit) &&
        Math.abs(chit.x - room.x) <= w / 2 + 0.02 && Math.abs(chit.z - room.z) <= l / 2 + 0.02) {
      cands.push({ surface: 'ceiling', room, point: chit, dist: ray.origin.distanceTo(chit) });
    }
  });
  setRoomCtx(null);
  cands.sort((a, b) => a.dist - b.dist);
  return cands[0] || null;
}

// Distance from the wall's left corner to a world point, along the wall of the
// given room (the surface-hit's room).
function wallOffsetFromPoint(wall, p, room) {
  if (room) setRoomCtx(room);
  const b = wallBasis(wall);
  const corner = wallAlongPoint(wall, 0);
  const off = (p.x - corner.x) * b.tan.x + (p.z - corner.z) * b.tan.z;
  return clampv(off, 0, wallLength(wall));
}

// A surface hit nudged slightly off the surface into the room (for handles).
function snapPoint(s) {
  const room = s.room || activeRoom();
  if (s.surface === 'ceiling') return { x: s.point.x, y: room.floor + room.height - 0.03, z: s.point.z };
  const b = wallBasis(s.wall);
  return {
    x: s.point.x - b.ex.x * 0.03,
    y: clampv(s.point.y, room.floor, room.floor + room.height),
    z: s.point.z - b.ex.z * 0.03,
  };
}

function queueRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => { rebuildQueued = false; buildScene(); });
}

function beginMove(pick) {
  drag = { kind: pick.kind, id: pick.id, index: pick.index };
  controls.enabled = false;
}

function updateMove(cx, cy) {
  // Control-point drag: snap the waypoint to any wall/ceiling surface.
  if (drag.kind === 'wirepoint') {
    const wire = state.wires.find((w) => w.id === drag.id);
    if (!wire || !Array.isArray(wire.points)) return;
    const s = pickSurface(cx, cy);
    if (!s) return;
    wire.points[drag.index] = snapPoint(s);
    queueRebuild();
    return;
  }

  const s = pickSurface(cx, cy);
  if (!s) return;

  const room = s.room || activeRoom();
  if (drag.kind === 'light') {
    const lt = state.lights.find((x) => x.id === drag.id); if (!lt) return;
    lt.room = room.id;
    if (s.surface === 'ceiling') {
      lt.mount = 'ceiling';
      lt.x = round2(clampv(s.point.x - room.x + room.width / 2, 0, room.width));
      lt.z = round2(clampv(s.point.z - room.z + room.length / 2, 0, room.length));
    } else {
      lt.mount = 'wall'; lt.wall = s.wall; lt.side = 'left';
      lt.offset = round2(wallOffsetFromPoint(s.wall, s.point, room));
      lt.elevation = round2(clampv(s.point.y - room.floor, 0, room.height));
    }
  } else if (s.surface === 'wall') {
    if (drag.kind === 'element') {
      const el = state.elements.find((x) => x.id === drag.id); if (!el) return;
      el.room = room.id;
      el.wall = s.wall; el.side = 'left';
      el.offset = round2(wallOffsetFromPoint(s.wall, s.point, room));
      el.elevation = round2(clampv(s.point.y - room.floor, 0, room.height));
    } else if (drag.kind === 'wallobj') {
      const o = state.wallObjects.find((x) => x.id === drag.id); if (!o) return;
      o.room = room.id;
      o.wall = s.wall; o.side = 'left';
      o.offset = round2(wallOffsetFromPoint(s.wall, s.point, room));
      o.elevation = round2(clampv(s.point.y - room.floor, o.height / 2, room.height - o.height / 2));
    } else if (drag.kind === 'door') {
      const d = state.doors.find((x) => x.id === drag.id); if (!d) return;
      d.room = room.id;
      d.wall = s.wall; d.side = 'left';
      const center = wallOffsetFromPoint(s.wall, s.point, room);
      d.offset = round2(clampv(center - d.width / 2, 0, wallLength(s.wall) - d.width));
    }
  }
  queueRebuild();
}

function endMove() {
  controls.enabled = true;
  buildScene();
  renderResults();
  renderElemList();
  renderObjList();
  renderDoorList();
  renderLightList();
  renderWireOptions();
  renderWireList();
  drag = null;
}

// Index in wire.points where a new waypoint near world point `p` belongs.
// The rendered route has extra orthogonal elbow points per leg, so the nearest
// route segment must be mapped back to the gap between manual waypoints its
// leg spans — a raw segment index would not line up with wire.points.
function wireInsertIndexAt(wire, p) {
  const from = findNode(wire.from);
  const to = findNode(wire.to);
  if (!from || !to) return 0;
  const a = nodeWorld(from);
  const b = nodeWorld(to);
  const raw = Array.isArray(wire.points) ? wire.points : [];
  // Each leg ends at a resolvable waypoint (insert = its wire.points index)
  // or at the destination node (insert = raw.length → append).
  const legs = [];
  raw.forEach((pt, i) => {
    let v = null;
    if (pt.node) {
      const n = findNode(pt.node);
      if (n) { const w = nodeWorld(n); v = new THREE.Vector3(w.x, w.y, w.z); }
    } else {
      v = new THREE.Vector3(pt.x, pt.y, pt.z);
    }
    if (v) legs.push({ end: v, insert: i });
  });
  legs.push({ end: new THREE.Vector3(b.x, b.y, b.z), insert: raw.length });
  let prev = new THREE.Vector3(a.x, a.y, a.z);
  let best = 0;
  let bestD = Infinity;
  legs.forEach((leg) => {
    const legPts = [prev, ...orthoLeg(prev, leg.end, wire.ceiling)];
    for (let i = 0; i < legPts.length - 1; i++) {
      const d = distToSegment(p, legPts[i], legPts[i + 1]);
      if (d < bestD) { bestD = d; best = leg.insert; }
    }
    prev = leg.end;
  });
  return best;
}

// Insert a control point on a wire where it was clicked, then start dragging it.
function insertWirePoint(wireId, cx, cy) {
  const wire = state.wires.find((w) => w.id === wireId);
  const s = pickSurface(cx, cy);
  if (!wire || !s) return false;
  const idx = wireInsertIndexAt(wire, s.point);
  if (!Array.isArray(wire.points)) wire.points = [];
  wire.points.splice(idx, 0, snapPoint(s));
  drag = { kind: 'wirepoint', id: wireId, index: idx };
  controls.enabled = false;
  buildScene();
  return true;
}

function distToSegment(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const t = clampv(new THREE.Vector3().subVectors(p, a).dot(ab) / (ab.lengthSq() || 1), 0, 1);
  return p.distanceTo(new THREE.Vector3().addVectors(a, ab.multiplyScalar(t)));
}

const isNodePick = (p) => p && (p.kind === 'element' || p.kind === 'light');

function beginWire(pick) {
  wireDrag = { from: pick.id };
  controls.enabled = false;
  const a = nodeWorld(findNode(pick.id));
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(a.x, a.y, a.z),
  ]);
  tempWireLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf59e0b }));
  scene.add(tempWireLine);
}

function updateWire(cx, cy) {
  const from = findNode(wireDrag.from);
  if (!from) return;
  const a = nodeWorld(from);
  const start = new THREE.Vector3(a.x, a.y, a.z);
  const pick = pickObject(cx, cy);
  let end;
  if (isNodePick(pick) && pick.id !== wireDrag.from) {
    const b = nodeWorld(findNode(pick.id));
    end = new THREE.Vector3(b.x, b.y, b.z);
  } else {
    setNdc(cx, cy);
    raycaster.setFromCamera(ndc, camera);
    const n = new THREE.Vector3();
    camera.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, start);
    end = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, end)) end = start.clone();
  }
  tempWireLine.geometry.setFromPoints([start, end]);
}

function endWire(cx, cy) {
  const pick = pickObject(cx, cy);
  if (isNodePick(pick) && pick.id !== wireDrag.from) {
    // Dropped on another device/light → create a wire between them.
    const dup = state.wires.some((w) =>
      (w.from === wireDrag.from && w.to === pick.id) || (w.from === pick.id && w.to === wireDrag.from));
    if (!dup) {
      pushHistory();
      state.wires.push({
        id: 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        from: wireDrag.from, to: pick.id, ceiling: els.wireCeiling.checked, lane: 0, ...readWireType(),
      });
      buildScene();
      renderWireList();
    }
  } else if (pick && pick.kind === 'wirepoint') {
    // Dropped on an existing control point → connect this device into that
    // cable right at the junction (route the wire through the device there).
    const wire = state.wires.find((w) => w.id === pick.id);
    if (wire && Array.isArray(wire.points) && wire.from !== wireDrag.from &&
        wire.to !== wireDrag.from && wire.points[pick.index] &&
        wire.points[pick.index].node !== wireDrag.from) {
      pushHistory();
      wire.points.splice(pick.index + 1, 0, { node: wireDrag.from });
      buildScene();
      renderWireList();
    }
  } else if (pick && pick.kind === 'wireline') {
    // Dropped on an existing cable → connect this device into that cable.
    const wire = state.wires.find((w) => w.id === pick.id);
    if (wire && wire.from !== wireDrag.from && wire.to !== wireDrag.from) {
      const p = nodeWorld(findNode(wireDrag.from));
      const idx = wireInsertIndexAt(wire, new THREE.Vector3(p.x, p.y, p.z));
      if (!Array.isArray(wire.points)) wire.points = [];
      pushHistory();
      wire.points.splice(idx, 0, { node: wireDrag.from });
      buildScene();
      renderWireList();
    }
  }
  if (tempWireLine) {
    scene.remove(tempWireLine);
    tempWireLine.geometry.dispose();
    tempWireLine.material.dispose();
    tempWireLine = null;
  }
  controls.enabled = true;
  wireDrag = null;
}

// Capture phase so we can disable OrbitControls before it starts panning.
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (interactionMode === 'orbit' || e.button !== 0) return;
  const pick = pickObject(e.clientX, e.clientY);
  if (!pick) return;
  // Control-point handles are draggable in both move and wire modes.
  if (pick.kind === 'wirepoint') {
    // Manual double-click detection: pointerdown's preventDefault (needed to
    // stop OrbitControls) suppresses the native dblclick event, so detect it
    // here — second quick click on the same handle removes the control point.
    const now = Date.now();
    if (lastPointClick && lastPointClick.id === pick.id &&
        lastPointClick.index === pick.index && now - lastPointClick.t < 400) {
      lastPointClick = null;
      const wire = state.wires.find((w) => w.id === pick.id);
      if (wire && Array.isArray(wire.points)) {
        pushHistory();
        wire.points.splice(pick.index, 1);
        buildScene();
        renderWireList();
      }
      e.preventDefault();
      return;
    }
    lastPointClick = { id: pick.id, index: pick.index, t: now };
    pushHistory();
    beginMove(pick);
    e.preventDefault();
    return;
  }
  if (interactionMode === 'move') {
    if (draggableKind(pick.kind)) { pushHistory(); beginMove(pick); e.preventDefault(); }
  } else if (interactionMode === 'wire') {
    if (pick.kind === 'element' || pick.kind === 'light') { pushHistory(); beginWire(pick); e.preventDefault(); }
    else if (pick.kind === 'wireline') {
      pushHistory();
      if (insertWirePoint(pick.id, e.clientX, e.clientY)) e.preventDefault();
    }
  }
}, true);

// ---------- Control-point palette (drag the chip onto a wire) ----------
let placingPoint = false;
els.cpChip.addEventListener('pointerdown', (e) => {
  placingPoint = true;
  els.cpChip.classList.add('dragging');
  e.preventDefault();
});

// Insert a control point on the wire under the cursor (no drag afterwards).
function insertWirePointAt(cx, cy) {
  const pick = pickObject(cx, cy);
  if (!pick || pick.kind !== 'wireline') return false;
  const wire = state.wires.find((w) => w.id === pick.id);
  const s = pickSurface(cx, cy);
  if (!wire || !s) return false;
  const idx = wireInsertIndexAt(wire, s.point);
  if (!Array.isArray(wire.points)) wire.points = [];
  pushHistory();
  wire.points.splice(idx, 0, snapPoint(s));
  buildScene();
  renderWireList();
  return true;
}

// ---------- Undo history ----------
const history = [];
let restoring = false;
function pushHistory() {
  if (restoring) return;
  try {
    const snap = JSON.stringify(serializeState());
    if (history[history.length - 1] !== snap) history.push(snap);
    if (history.length > 60) history.shift();
  } catch (err) { /* ignore */ }
}
function undo() {
  if (!history.length) return;
  const snap = history.pop();
  restoring = true;
  try { applyImported(JSON.parse(snap), { jump: false }); } catch (err) { /* ignore */ }
  restoring = false;
}

// ---------- Hotkeys: ⌘Z undo, ⌘S overwrite/save ----------
window.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  const k = e.key.toLowerCase();
  if (k === 'z' && !typing) { e.preventDefault(); undo(); }
  else if (k === 's') { e.preventDefault(); if (hasProject) els.overwriteBtn.click(); }
});

window.addEventListener('pointermove', (e) => {
  if (drag) updateMove(e.clientX, e.clientY);
  else if (wireDrag) updateWire(e.clientX, e.clientY);
  else updateDrywallHover(e.clientX, e.clientY);
});

window.addEventListener('pointerup', (e) => {
  if (placingPoint) {
    placingPoint = false;
    els.cpChip.classList.remove('dragging');
    insertWirePointAt(e.clientX, e.clientY);
    return;
  }
  if (drag) endMove();
  else if (wireDrag) endWire(e.clientX, e.clientY);
});

setMode('orbit');

init();
