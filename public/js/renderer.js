// three.js renderer — owned by the Renderer agent. See DESIGN.md §14.
import * as THREE from 'three';
import { TILE, RARITY } from './core.js';
import { getTextures } from './textures.js';
import { Models, SWING_DURATION } from './models.js';

// Entities read small from the angled top-down camera, so scale them up uniformly.
const ENTITY_SCALE = 1.3;

// --- Combat "game feel" tunables ---------------------------------------------------
const HIT_FLASH_WINDOW = 0.12;    // seconds over which the white hit-flash intensity ramps in
const HIT_RECOIL_DURATION = 0.12; // seconds for the knockback-independent hit recoil to spring back
const HIT_RECOIL_DIST = 0.2;      // tiles the mesh is shoved away from the attacker on a hit
const HIT_SQUASH_DURATION = 0.12; // seconds for the squash-and-stretch pop to settle
const HIT_SQUASH_AMOUNT = 0.22;   // fractional scale pop on hit
const CRIT_FLOAT_POP_DURATION = 0.15; // seconds the crit float-text stays enlarged
const CRIT_FLOAT_POP_AMOUNT = 0.35;   // extra scale on crit float-text at spawn
const HIT_BURST_COUNT = 10, HIT_BURST_SPEED = 2.5, HIT_BURST_SIZE = 0.09;
const CRIT_BURST_COUNT = 18, CRIT_BURST_SPEED = 3.6, CRIT_BURST_SIZE = 0.12;
const CRIT_FLASH_DURATION = 0.22; // extra bright pop sprite on a crit hit
const DEATH_POP_FRAC = 0.14;      // fraction of the death timer spent on the initial "pop"
const DEATH_POP_AMOUNT = 0.28;    // how much the mesh pops up before it implodes

// Bright, cheerful per-depth palettes. `sky` is the background/fog colour that
// unexplored space fades into, so the dungeon reads as a sunny floating maze.
// Exported so the HUD minimap can colour the down-stairs marker with the same `accent` as the
// floating 3D stairs sign (see depthTheme()).
export const DEPTH_THEMES = [
  { name: 'meadow', floor: 0x8fd46a, wall: 0xf4e4c1, sky: 0xaee3ff, accent: 0xff4fa0, torch: 0xffd27a },
  { name: 'beach',  floor: 0xf7dc8f, wall: 0xff9f80, sky: 0x9fe9ff, accent: 0x14b8ff, torch: 0xffe08a },
  { name: 'candy',  floor: 0xffc6e0, wall: 0xb9a4ff, sky: 0xfff0fa, accent: 0xff3d8b, torch: 0xffb3e0 },
  { name: 'frost',  floor: 0xd4f1ff, wall: 0x7cc6ff, sky: 0xeaf8ff, accent: 0x2f7bff, torch: 0xbfe9ff },
  { name: 'autumn', floor: 0xffc978, wall: 0xe9806a, sky: 0xffe9c7, accent: 0x9b3dff, torch: 0xffc070 },
];
export function depthTheme(depth) {
  return DEPTH_THEMES[(Math.max(1, depth || 1) - 1) % DEPTH_THEMES.length];
}

// The themes' pastel skies were too bright behind the map, so the background/fog colour is each
// theme's sky blended toward a deep dusk tone — and it sinks further toward dusk the deeper you go.
// Blend: 0 = the original pastel, 1 = pure dusk.
const SKY_DUSK = 0x161c28;
const SKY_DARKEN_START = 0.62;     // blend at depth 1
const SKY_DARKEN_PER_DEPTH = 0.015; // extra blend per depth
const SKY_DARKEN_MAX = 0.94;       // reached around depth 22
function themeSky(theme, depth = 1) {
  const t = Math.min(SKY_DARKEN_MAX, SKY_DARKEN_START + SKY_DARKEN_PER_DEPTH * Math.max(0, depth - 1));
  // Blend in sRGB (screen) space: THREE.Color.lerp works in linear space, which keeps the result far brighter.
  const mix = (shift) => {
    const a = (theme.sky >> shift) & 255, b = (SKY_DUSK >> shift) & 255;
    return Math.round(a + (b - a) * t);
  };
  return new THREE.Color((mix(16) << 16) | (mix(8) << 8) | mix(0));
}

const FLOOR_STATE = { HIDDEN: 0, DIM: 1, LIT: 2 };

const TMP_COLOR = new THREE.Color();
const TMP_COLOR2 = new THREE.Color();
const TMP_MATRIX = new THREE.Matrix4();
const TMP_VEC = new THREE.Vector3();
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);

// ---------------------------------------------------------------- material shader patches
// Atlas textures are 2x2 cells; per-instance `aCell` (0 or 0.5 per axis) picks a cell.
const ATLAS_UV = `
#ifdef USE_MAP
  vMapUv = vMapUv * 0.5 + aCell;
#endif
#ifdef USE_NORMALMAP
  vNormalMapUv = vNormalMapUv * 0.5 + aCell;
#endif
#ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv = vRoughnessMapUv * 0.5 + aCell;
#endif
`;

function patchAtlasMaterial(mat, key) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + ATLAS_UV);
  };
  mat.customProgramCacheKey = () => key;
}

// Floor: atlas cell + fake ambient occlusion along edges/corners that touch walls.
// aEdge = walls at (-x, +x, -z, +z); aCorner = diagonal walls at (-x-z, +x-z, -x+z, +x+z).
function patchFloorMaterial(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aCell;
attribute vec4 aEdge;
attribute vec4 aCorner;
varying vec2 vTileLocal;
varying vec4 vEdge;
varying vec4 vCorner;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
${ATLAS_UV}
  vTileLocal = (instanceMatrix * vec4(position, 1.0)).xz - instanceMatrix[3].xz + 0.5;
  vEdge = aEdge;
  vCorner = aCorner;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vTileLocal;
varying vec4 vEdge;
varying vec4 vCorner;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec2 l = clamp(vTileLocal, 0.0, 1.0);
    vec2 r = 1.0 - l;
    const float W = 0.45;
    float ao = 0.0;
    ao = max(ao, vEdge.x * (1.0 - smoothstep(0.0, W, l.x)));
    ao = max(ao, vEdge.y * (1.0 - smoothstep(0.0, W, r.x)));
    ao = max(ao, vEdge.z * (1.0 - smoothstep(0.0, W, l.y)));
    ao = max(ao, vEdge.w * (1.0 - smoothstep(0.0, W, r.y)));
    ao = max(ao, vCorner.x * (1.0 - smoothstep(0.0, W, length(vec2(l.x, l.y)))));
    ao = max(ao, vCorner.y * (1.0 - smoothstep(0.0, W, length(vec2(r.x, l.y)))));
    ao = max(ao, vCorner.z * (1.0 - smoothstep(0.0, W, length(vec2(l.x, r.y)))));
    ao = max(ao, vCorner.w * (1.0 - smoothstep(0.0, W, length(vec2(r.x, r.y)))));
    diffuseColor.rgb *= 1.0 - 0.5 * ao * (2.0 - ao) * 0.9;
  }`);
  };
  mat.customProgramCacheKey = () => 'floor-ao';
}

// Wall sides: world-space UVs so brick courses run continuously along a wall
// (texture spans 2 units horizontally and the full 1.2 wall height).
function patchWallSideMaterial(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
  {
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 wn = mat3(modelMatrix) * mat3(instanceMatrix) * normal;
    vec2 wuv;
    if (abs(wn.x) > abs(wn.z) && abs(wn.x) > abs(wn.y)) wuv = vec2(wn.x > 0.0 ? -wp.z : wp.z, wp.y);
    else if (abs(wn.z) > abs(wn.y)) wuv = vec2(wn.z > 0.0 ? wp.x : -wp.x, wp.y);
    else wuv = wp.xz;
    wuv = vec2(wuv.x * 0.5 + 0.25, wuv.y / 1.2);
#ifdef USE_MAP
    vMapUv = wuv;
#endif
#ifdef USE_NORMALMAP
    vNormalMapUv = wuv;
#endif
#ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv = wuv;
#endif
  }`);
  };
  mat.customProgramCacheKey = () => 'wall-side';
}

// Deterministic per-tile hash in [0,1) so a level looks the same when rebuilt.
function tileHash(x, y, salt) {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(salt, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function facingAngle(fx, fy) {
  if (!fx && !fy) return 0;
  return Math.atan2(fx, fy);
}

export class Renderer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = themeSky(DEPTH_THEMES[0]);

    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(50, w / Math.max(1, h), 0.1, 120);
    this.pitch = THREE.MathUtils.degToRad(60);
    this.desiredTilesX = 28;
    this._camTarget = new THREE.Vector3(0, 0, 0);
    this._camInit = false;
    this._camDist = 16;
    this._camOffsetY = 14;
    this._camOffsetZ = 8;
    this._shakeTime = 0;
    this._shakeMag = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = false;
    const dom = this.renderer.domElement;
    dom.style.position = 'absolute';
    dom.style.inset = '0';
    dom.style.width = '100%';
    dom.style.height = '100%';
    dom.style.display = 'block';

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(dom);

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5;';
    container.appendChild(this.overlay);
    this._floatTexts = [];
    this._floatTextCap = 40;

    this.renderer.setSize(w, h, false);

    this._onResizeBound = () => this._onResize();
    window.addEventListener('resize', this._onResizeBound);
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(this._onResizeBound);
      this._ro.observe(container);
    }

    // Lights: few real lights per spec — cool hemisphere/ambient, one warm torch light
    // that follows the player, and a faint directional for shading.
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0xcdb89a, 1.7);
    this.scene.add(this.hemiLight);
    this.dirLight = new THREE.DirectionalLight(0xfff6e0, 1.5);
    this.dirLight.position.set(-3, 10, 5);
    this.scene.add(this.dirLight);
    this.torchLight = new THREE.PointLight(0xffe2a8, 4, 7, 1.6);
    this.torchLight.position.set(0, 2.2, 0);
    this.scene.add(this.torchLight);

    this.scene.fog = new THREE.Fog(themeSky(DEPTH_THEMES[0]), 22, 48);

    this._time = 0;

    this._buildSharedAssets();
    this.models = new Models(this);
    this._recomputeCameraDistance();

    this.map = null;
    this.depth = 1;
    this._theme = DEPTH_THEMES[0];
    this._floorTiles = [];
    this._wallTiles = [];
    this._floorMesh = null;
    this._wallMesh = null;
    this._levelGroup = new THREE.Group();
    this.scene.add(this._levelGroup);
    this._torches = [];
    this._doorDecor = [];
    this._entranceMarker = null;
    this._exitMarkers = [];

    this.playerEntry = null;
    this.enemyEntries = new Map();
    this.itemEntries = new Map();
    this.npcEntries = new Map();
    this.projectileEntries = new Map();
    this.effects = [];
  }

  // ---------------------------------------------------------------- shared assets
  _buildSharedAssets() {
    this._geo = {
      floor: new THREE.BoxGeometry(1, 0.1, 1),
      wall: new THREE.BoxGeometry(1, 1.2, 1),
      sphereLow: new THREE.SphereGeometry(0.5, 8, 6),
      box: new THREE.BoxGeometry(1, 1, 1),
      cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
      cone: new THREE.ConeGeometry(0.5, 1, 8),
      ring: new THREE.RingGeometry(0.6, 0.75, 28, 1),
      arc: new THREE.RingGeometry(0.35, 0.95, 20, 1, -Math.PI * 0.35, Math.PI * 0.7),
      torus: new THREE.TorusGeometry(0.5, 0.08, 8, 24),
      plane: new THREE.PlaneGeometry(1, 1),
    };
    this._geo.floor.translate(0, -0.05, 0);
    this._geo.wall.translate(0, 0.6, 0);

    this._geo.torchCup = new THREE.CylinderGeometry(0.5, 0.32, 1, 10, 1, true);
    this._geo.flame = new THREE.ConeGeometry(0.5, 1, 10, 1, true);
    this._geo.flame.translate(0, 0.5, 0);
    this._geo.blob = new THREE.PlaneGeometry(1, 1);
    this._geo.blob.rotateX(-Math.PI / 2);
    // Ground-loot shapes: flat pad disc/ring on the floor, half-torus for bows.
    this._geo.lootDisc = new THREE.CircleGeometry(0.5, 32);
    this._geo.lootDisc.rotateX(-Math.PI / 2);
    this._geo.lootRing = new THREE.RingGeometry(0.4, 0.5, 40, 1);
    this._geo.lootRing.rotateX(-Math.PI / 2);
    this._geo.bowArc = new THREE.TorusGeometry(0.5, 0.12, 6, 18, Math.PI);
    // Boss attack telegraphs: flat unit-radius decals, scaled per-instance. Materials are
    // cloned per effect (opacity/color animate independently) but geometry is always shared.
    this._geo.telegraphDisc = new THREE.CircleGeometry(1, 32);
    this._geo.telegraphDisc.rotateX(-Math.PI / 2);
    this._geo.telegraphRing = new THREE.RingGeometry(0.92, 1.0, 32);
    this._geo.telegraphRing.rotateX(-Math.PI / 2);
    this._telegraphFillMatTpl = new THREE.MeshBasicMaterial({
      color: 0xff3b3b, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this._telegraphRingMatTpl = new THREE.MeshBasicMaterial({
      color: 0xff3b3b, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
    });

    // Procedural textures (generated once; see textures.js).
    const tx = getTextures(this.renderer.capabilities.getMaxAnisotropy());
    this._tex = tx;
    const shared = (m) => { m.userData.shared = true; return m; };

    this._floorMat = new THREE.MeshStandardMaterial({
      map: tx.floor.map, normalMap: tx.floor.normalMap, roughnessMap: tx.floor.roughnessMap,
      normalScale: new THREE.Vector2(1.1, 1.1), roughness: 1, metalness: 0.03,
    });
    patchFloorMaterial(this._floorMat);
    const wallSide = new THREE.MeshStandardMaterial({
      map: tx.wallSide.map, normalMap: tx.wallSide.normalMap, roughnessMap: tx.wallSide.roughnessMap,
      normalScale: new THREE.Vector2(1.2, 1.2), roughness: 1, metalness: 0.03,
    });
    patchWallSideMaterial(wallSide);
    const wallTop = new THREE.MeshStandardMaterial({
      map: tx.wallTop.map, normalMap: tx.wallTop.normalMap, roughnessMap: tx.wallTop.roughnessMap,
      normalScale: new THREE.Vector2(1.1, 1.1), roughness: 1, metalness: 0.03,
    });
    patchAtlasMaterial(wallTop, 'walltop');
    // BoxGeometry groups: +x, -x, +y (top), -y, +z, -z.
    this._wallMat = [wallSide, wallSide, wallTop, wallSide, wallSide, wallSide];

    this._woodMat = shared(new THREE.MeshStandardMaterial({
      map: tx.wood.map, normalMap: tx.wood.normalMap, roughnessMap: tx.wood.roughnessMap, roughness: 1, metalness: 0.02,
    }));
    this._ironMat = shared(new THREE.MeshStandardMaterial({ color: 0x8a8c98, roughness: 0.4, metalness: 0.6 }));
    this._torchWoodMat = shared(new THREE.MeshStandardMaterial({ color: 0x8a5a34, map: tx.wood.map, roughness: 0.85 }));
    this._flameOuterMat = shared(new THREE.MeshBasicMaterial({ color: 0xff9a2e, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this._flameInnerMat = shared(new THREE.MeshBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    this._glowMat = shared(new THREE.SpriteMaterial({ map: tx.glow, color: 0xffc070, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    this._blobMat = shared(new THREE.MeshBasicMaterial({ map: tx.shadow, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this._particleMat = new THREE.PointsMaterial({ size: 0.12, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  }

  // ---------------------------------------------------------------- resize / camera
  _onResize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this._recomputeCameraDistance();
  }

  _recomputeCameraDistance() {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = this.desiredTilesX / (2 * Math.tan(hFov / 2));
    this._camDist = THREE.MathUtils.clamp(dist, 8, 60);
    this._camOffsetY = this._camDist * Math.sin(this.pitch);
    this._camOffsetZ = this._camDist * Math.cos(this.pitch);
  }

  // ---------------------------------------------------------------- material helper
  _newMat(color, extra, materialsList) {
    const m = new THREE.MeshStandardMaterial(Object.assign({
      color, roughness: 0.6, metalness: 0.15, transparent: true, opacity: 1, emissive: 0x000000,
    }, extra || {}));
    m.userData.baseEmissive = m.emissive.clone();
    m.userData.baseEmissiveIntensity = m.emissiveIntensity;
    m.userData.baseOpacity = m.opacity;
    if (materialsList) materialsList.push(m);
    return m;
  }

  // Soft contact shadow under an entity (shared material; lives in the entity's root).
  _makeBlobShadow(size) {
    const blob = new THREE.Mesh(this._geo.blob, this._blobMat);
    blob.scale.set(size, 1, size);
    blob.position.y = 0.012;
    blob.renderOrder = -1;
    return blob;
  }

  _disposeDecor(obj) {
    obj.traverse((child) => {
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mm of mats) {
          if (mm.userData.shared) continue;
          if (mm.userData.disposeMap && mm.map) mm.map.dispose();
          mm.dispose();
        }
      }
    });
  }

  // ================================================================== buildMap
  buildMap(map, depth) {
    this._disposeLevel();
    this.map = map;
    this.depth = depth || 1;
    const theme = depthTheme(this.depth);
    this._theme = theme;
    this.scene.fog.color.copy(themeSky(theme, this.depth));
    this.scene.background.copy(themeSky(theme, this.depth));
    this.torchLight.color.setHex(theme.torch);
    this._glowMat.color.setHex(theme.torch);

    if (!map) return;
    const w = map.width, h = map.height;

    const floorList = [];
    const wallList = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = map.get(x, y);
        if (t === TILE.FLOOR || t === TILE.DOOR || t === TILE.ENTRANCE || t === TILE.EXIT) {
          floorList.push({ x, y, t });
        } else if (t === TILE.WALL) {
          let touch = false;
          for (let dy = -1; dy <= 1 && !touch; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = x + dx, ny = y + dy;
              if (map.inBounds(nx, ny)) {
                const nt = map.get(nx, ny);
                if (nt === TILE.FLOOR || nt === TILE.DOOR || nt === TILE.ENTRANCE || nt === TILE.EXIT) { touch = true; break; }
              }
            }
          }
          if (touch) wallList.push({ x, y });
        }
      }
    }

    // Per-level geometry clones carry the per-instance attributes (atlas cell, wall AO masks).
    const nF = Math.max(1, floorList.length), nW = Math.max(1, wallList.length);
    const floorGeo = this._geo.floor.clone();
    const wallGeo = this._geo.wall.clone();
    const fCell = new Float32Array(nF * 2), fEdge = new Float32Array(nF * 4), fCorner = new Float32Array(nF * 4);
    const wCell = new Float32Array(nW * 2);

    const floorMesh = new THREE.InstancedMesh(floorGeo, this._floorMat, nF);
    floorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const wallMesh = new THREE.InstancedMesh(wallGeo, this._wallMat, nW);
    wallMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const isWall = (x, y) => !map.inBounds(x, y) || map.get(x, y) === TILE.WALL;
    const seed = (this.depth * 7919) | 0;
    // Random multiple of 90° per tile + one of 4 atlas cells => 16 looks per tile, no obvious repeats.
    this._floorTiles = floorList.map((f, i) => {
      const cell = Math.floor(tileHash(f.x, f.y, seed + 1) * 4);
      fCell[i * 2] = (cell & 1) * 0.5; fCell[i * 2 + 1] = (cell >> 1) * 0.5;
      const ex0 = isWall(f.x - 1, f.y), ex1 = isWall(f.x + 1, f.y), ez0 = isWall(f.x, f.y - 1), ez1 = isWall(f.x, f.y + 1);
      fEdge.set([+ex0, +ex1, +ez0, +ez1], i * 4);
      fCorner.set([
        +(!ex0 && !ez0 && isWall(f.x - 1, f.y - 1)), +(!ex1 && !ez0 && isWall(f.x + 1, f.y - 1)),
        +(!ex0 && !ez1 && isWall(f.x - 1, f.y + 1)), +(!ex1 && !ez1 && isWall(f.x + 1, f.y + 1)),
      ], i * 4);
      return {
        x: f.x, y: f.y, t: f.t, index: i, state: -1,
        hidden: f.t === TILE.EXIT, // down-stairs pit replaces the floor slab
        rot: Math.floor(tileHash(f.x, f.y, seed + 2) * 4) * Math.PI / 2,
        shade: 0.94 + tileHash(f.x, f.y, seed + 3) * 0.1,
      };
    });
    this._wallTiles = wallList.map((wt, i) => {
      const cell = Math.floor(tileHash(wt.x, wt.y, seed + 4) * 4);
      wCell[i * 2] = (cell & 1) * 0.5; wCell[i * 2 + 1] = (cell >> 1) * 0.5;
      return {
        x: wt.x, y: wt.y, index: i, state: -1,
        rot: Math.floor(tileHash(wt.x, wt.y, seed + 5) * 4) * Math.PI / 2,
        shade: 0.95 + tileHash(wt.x, wt.y, seed + 6) * 0.08,
      };
    });
    floorGeo.setAttribute('aCell', new THREE.InstancedBufferAttribute(fCell, 2));
    floorGeo.setAttribute('aEdge', new THREE.InstancedBufferAttribute(fEdge, 4));
    floorGeo.setAttribute('aCorner', new THREE.InstancedBufferAttribute(fCorner, 4));
    wallGeo.setAttribute('aCell', new THREE.InstancedBufferAttribute(wCell, 2));

    for (const f of this._floorTiles) {
      floorMesh.setMatrixAt(f.index, this._tileMatrix(f));
      floorMesh.setColorAt(f.index, TMP_COLOR.setHex(0x000000));
    }
    for (const wt of this._wallTiles) {
      wallMesh.setMatrixAt(wt.index, this._tileMatrix(wt));
      wallMesh.setColorAt(wt.index, TMP_COLOR.setHex(0x000000));
    }
    // Fog of war rewrites these every step; dynamic usage avoids GPU stalls on re-upload.
    floorMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    wallMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    floorMesh.instanceMatrix.needsUpdate = true;
    wallMesh.instanceMatrix.needsUpdate = true;
    if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;
    if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
    floorMesh.frustumCulled = false;
    wallMesh.frustumCulled = false;

    this._levelGroup.add(floorMesh, wallMesh);
    this._floorMesh = floorMesh;
    this._wallMesh = wallMesh;
    this._floorColor = new THREE.Color(theme.floor);
    this._wallColor = new THREE.Color(theme.wall);
    this._skyColor = themeSky(theme, this.depth);

    for (const f of this._floorTiles) {
      if (f.t === TILE.DOOR) this._buildDoorDecor(map, f.x, f.y);
    }

    if (map.entrance) this._entranceMarker = this._buildStairs(map.entrance, false);
    if (map.exits) for (const e of map.exits) this._exitMarkers.push(this._buildStairs(e, true));

    this._placeTorches(map, wallList);
  }

  _tileMatrix(tile) {
    TMP_MATRIX.makeRotationY(tile.rot || 0);
    TMP_MATRIX.setPosition(tile.x, 0, tile.y);
    return TMP_MATRIX;
  }

  _disposeLevel() {
    // Any in-flight effect (in particular boss attack telegraphs) is tied to world-space
    // coordinates on the old map — drop them rather than let them linger into the new depth.
    for (let i = this.effects.length - 1; i >= 0; i--) this._disposeEffect(this.effects[i]);
    this.effects.length = 0;
    if (this._floorMesh) { this._levelGroup.remove(this._floorMesh); this._floorMesh.geometry.dispose(); this._floorMesh.dispose(); this._floorMesh = null; }
    if (this._wallMesh) { this._levelGroup.remove(this._wallMesh); this._wallMesh.geometry.dispose(); this._wallMesh.dispose(); this._wallMesh = null; }
    for (const d of this._doorDecor) { this._levelGroup.remove(d); this._disposeDecor(d); }
    this._doorDecor = [];
    if (this._entranceMarker) { this._levelGroup.remove(this._entranceMarker.root); this._disposeDecor(this._entranceMarker.root); this._entranceMarker = null; }
    for (const m of this._exitMarkers) { this._levelGroup.remove(m.root); this._disposeDecor(m.root); }
    this._exitMarkers = [];
    for (const t of this._torches) { this._levelGroup.remove(t.root); this._disposeDecor(t.root); }
    this._torches = [];
    this._floorTiles = [];
    this._wallTiles = [];
  }

  _buildDoorDecor(map, x, y) {
    const group = new THREE.Group();
    group.position.set(x, 0, y);
    const mat = this._woodMat, iron = this._ironMat;
    // `vertical`: walls left/right, so the passage runs along z. Build in that frame, rotate otherwise.
    const vertical = map.get(x - 1, y) === TILE.WALL && map.get(x + 1, y) === TILE.WALL;
    const frame = new THREE.Group();
    if (!vertical) frame.rotation.y = Math.PI / 2;
    group.add(frame);
    const threshold = new THREE.Mesh(this._geo.box, mat);
    threshold.scale.set(0.96, 0.06, 0.26);
    threshold.position.y = 0.03;
    frame.add(threshold);
    for (const s of [-1, 1]) {
      const jamb = new THREE.Mesh(this._geo.box, mat);
      jamb.scale.set(0.16, 0.95, 0.3);
      jamb.position.set(s * 0.42, 0.475, 0);
      frame.add(jamb);
      for (const hy of [0.22, 0.72]) {
        const band = new THREE.Mesh(this._geo.box, iron);
        band.scale.set(0.18, 0.05, 0.32);
        band.position.set(s * 0.42, hy, 0);
        frame.add(band);
      }
    }
    this._levelGroup.add(group);
    this._doorDecor.push(group);
  }

  // Round sign with a white chevron (up/down) on a colored disc, drawn per marker.
  _makeStairSignTexture(color, down) {
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const col = '#' + new THREE.Color(color).getHexString();
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.arc(S / 2, S / 2 + 5, 52, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(S / 2, S / 2, 54, 0, Math.PI * 2); g.fill();
    g.fillStyle = col;
    g.beginPath(); g.arc(S / 2, S / 2, 45, 0, Math.PI * 2); g.fill();
    g.save();
    g.translate(S / 2, S / 2);
    if (down) g.rotate(Math.PI);
    g.fillStyle = '#ffffff';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(0, -30); g.lineTo(26, -2); g.lineTo(11, -2); g.lineTo(11, 28);
    g.lineTo(-11, 28); g.lineTo(-11, -2); g.lineTo(-26, -2); g.closePath();
    g.fill();
    g.restore();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // Stairs sit in a one-tile cubby cut into a wall (map.js findNiche): up-stairs for the
  // entrance, stairs sinking into a dark pit for exits. Local frame: +z points out of
  // the cubby into the room; the cubby spans x,z in [-0.5, 0.5].
  _buildStairs(stair, down) {
    const root = new THREE.Group();
    root.position.set(stair.x, 0, stair.y);
    const dir = stair.dir || { x: 0, y: 1 };
    root.rotation.y = Math.atan2(dir.x, dir.y);
    const box = (m, sx, sy, sz, x, y, z) => {
      const b = new THREE.Mesh(this._geo.box, m);
      b.scale.set(sx, sy, sz); b.position.set(x, y, z);
      root.add(b);
      return b;
    };
    const mat = (color, extra) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.9, metalness: 0.02 }, extra || {}));

    const stone = new THREE.Color(this._theme.wall).multiplyScalar(0.82);
    const white = new THREE.Color(0xffffff);
    const dark = new THREE.Color(0x120f1a);
    const signColor = down ? this._theme.accent : 0x12b886;
    const STEPS = 6;
    let light, glow;

    if (!down) {
      // Steps climbing toward the back wall, brightening as they rise toward daylight.
      const depth = 1 / STEPS;
      for (let i = 0; i < STEPS; i++) {
        const top = (i + 1) * 0.17;
        const z = 0.5 - depth * (i + 0.5);
        const c = stone.clone().lerp(white, 0.05 + i * 0.07);
        box(mat(c), 0.88, top, depth, 0, top / 2, z);
        box(mat(c.clone().lerp(white, 0.35)), 0.88, 0.035, 0.05, 0, top + 0.012, z + depth / 2 - 0.025);
      }
      glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._tex.glow, color: 0xfff4c8, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.position.set(0, 1.15, -0.3);
      glow.scale.setScalar(1.3);
      root.add(glow);
      light = new THREE.PointLight(0xfff0c0, 3, 3.5, 2);
      light.position.set(0, 1.1, 0.1);
    } else {
      // A pit below floor level: side/back walls and a floor so the sky never shows through.
      const BOTTOM = -1.35;
      const pitMat = mat(stone.clone().lerp(dark, 0.7));
      for (const s of [-1, 1]) box(pitMat, 0.06, -BOTTOM, 1.0, s * 0.47, BOTTOM / 2, 0);
      box(new THREE.MeshBasicMaterial({ color: 0x0b0910 }), 1.0, -BOTTOM, 0.06, 0, BOTTOM / 2, -0.47);
      box(mat(dark), 1.0, 0.05, 1.0, 0, BOTTOM, 0);
      // Unlit black lining on the rock face behind: the doorway reads as a tunnel mouth,
      // with the top steps visibly dropping away into it.
      box(new THREE.MeshBasicMaterial({ color: 0x0b0910 }), 0.9, 1.22, 0.04, 0, 0.61, -0.46);
      // Steps sinking toward the back, fading into darkness.
      // Pale treads over dark risers so each step reads as a band, fading with depth.
      const depth = 0.94 / STEPS;
      for (let i = 0; i < STEPS; i++) {
        const top = -(i + 1) * 0.12 - i * i * 0.012; // shallow first steps stay in view
        const z = 0.5 - depth * (i + 0.5);
        const fade = i / (STEPS - 1);
        const riser = stone.clone().lerp(dark, 0.75 + fade * 0.2);
        const tread = stone.clone().lerp(white, 0.55).lerp(dark, fade * 0.4);
        box(mat(riser), 0.88, top - BOTTOM, depth, 0, (top + BOTTOM) / 2, z);
        box(mat(tread), 0.88, 0.03, depth - 0.03, 0, top + 0.015, z + 0.015);
      }
      // Soft neutral fill so the treads stay readable below floor level.
      light = new THREE.PointLight(0xfff2dd, 1.1, 1.2, 2);
      light.position.set(0, 0.1, 0.2);
    }
    root.add(light);

    // Timber arch across the mouth of the cubby, with a colored keystone.
    const frame = this._woodMat, iron = this._ironMat;
    for (const s of [-1, 1]) {
      box(frame, 0.14, 1.3, 0.22, s * 0.45, 0.65, 0.42);
      for (const hy of [0.25, 0.85]) box(iron, 0.16, 0.05, 0.24, s * 0.45, hy, 0.42);
    }
    box(frame, 1.06, 0.16, 0.26, 0, 1.3, 0.42);
    box(mat(signColor, { emissive: signColor, emissiveIntensity: 0.35 }), 0.2, 0.22, 0.28, 0, 1.3, 0.43);

    // Floating sign so the purpose reads at a glance, even from across a room.
    const signMat = new THREE.SpriteMaterial({ map: this._makeStairSignTexture(signColor, down), transparent: true, depthWrite: false });
    signMat.userData.disposeMap = true;
    const sign = new THREE.Sprite(signMat);
    sign.position.set(0, 1.85, 0.45);
    sign.scale.setScalar(down ? 0.62 : 0.5);
    root.add(sign);

    this._levelGroup.add(root);
    return { root, sign, light, glow, down, baseLight: light.intensity, phase: Math.random() * Math.PI * 2 };
  }

  _placeTorches(map, wallList) {
    if (!wallList.length) return;
    const targetCount = Math.min(40, Math.max(8, Math.round(wallList.length / 25)));
    const stride = Math.max(1, Math.floor(wallList.length / targetCount));
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < wallList.length; i += stride) {
      const wt = wallList[i];
      let nx = 0, ny = 0;
      for (const [dx, dy] of dirs) {
        if (map.inBounds(wt.x + dx, wt.y + dy)) {
          const nt = map.get(wt.x + dx, wt.y + dy);
          // Never hang a torch inside a stair cubby.
          if (nt === TILE.FLOOR || nt === TILE.DOOR) { nx = dx; ny = dy; break; }
        }
      }
      if (!nx && !ny) continue;
      this._torches.push(this._buildTorch(wt.x, wt.y, nx, ny));
      if (this._torches.length >= targetCount) break;
    }
  }

  _buildTorch(x, y, nx, ny) {
    const root = new THREE.Group();
    root.position.set(x + nx * 0.48, 0, y + ny * 0.48);
    root.rotation.y = Math.atan2(nx, ny); // local +z points away from the wall
    // Iron wall plate + arm, wooden handle tilted outward, iron cup, layered additive flame, glow sprite.
    const plate = new THREE.Mesh(this._geo.box, this._ironMat);
    plate.scale.set(0.16, 0.26, 0.04); plate.position.set(0, 0.78, 0.02);
    const arm = new THREE.Mesh(this._geo.box, this._ironMat);
    arm.scale.set(0.05, 0.05, 0.2); arm.position.set(0, 0.74, 0.11);
    const handle = new THREE.Mesh(this._geo.cylinder, this._torchWoodMat);
    handle.scale.set(0.06, 0.34, 0.06); handle.position.set(0, 0.86, 0.17); handle.rotation.x = 0.35;
    const cup = new THREE.Mesh(this._geo.torchCup, this._ironMat);
    cup.scale.set(0.15, 0.1, 0.15); cup.position.set(0, 1.03, 0.23);
    const flame = new THREE.Group();
    flame.position.set(0, 1.04, 0.23);
    const outer = new THREE.Mesh(this._geo.flame, this._flameOuterMat);
    outer.scale.set(0.2, 0.34, 0.2);
    const inner = new THREE.Mesh(this._geo.sphereLow, this._flameInnerMat);
    inner.scale.set(0.1, 0.14, 0.1); inner.position.y = 0.07;
    flame.add(outer, inner);
    const glow = new THREE.Sprite(this._glowMat);
    glow.position.set(0, 1.14, 0.26);
    glow.scale.setScalar(1.1);
    root.add(plate, arm, handle, cup, flame, glow);
    root.scale.setScalar(1.35);
    this._levelGroup.add(root);
    return { root, flame, glow, x, y, phase: Math.random() * Math.PI * 2 };
  }

  // ================================================================== per-frame update
  update(game, dt) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    this._time += dt;
    const map = game.map;
    if (map && map === this.map) this._updateFogOfWar(map);
    this._updateMarkers(dt);
    this._updateTorches(dt);
    this._updatePlayer(game, dt);
    this._syncEnemies(game, dt);
    this._syncNpcs(game, dt);
    this._syncItems(game, dt);
    this._syncProjectiles(game, dt);
    this._updateEffects(dt);
    this._updateFloatTexts(dt);
    this._updateCamera(game, dt);
  }

  _updateFogOfWar(map) {
    if (!this._floorMesh || !this._wallMesh) return;
    const floorColor = this._floorColor, wallColor = this._wallColor;
    let floorChanged = false, wallChanged = false;
    for (const f of this._floorTiles) {
      const idx = map.idx(f.x, f.y);
      const state = map.visible[idx] ? FLOOR_STATE.LIT : (map.explored[idx] ? FLOOR_STATE.DIM : FLOOR_STATE.HIDDEN);
      if (state === f.state) continue;
      f.state = state;
      floorChanged = true;
      this._floorMesh.setMatrixAt(f.index, state === FLOOR_STATE.HIDDEN || f.hidden ? TMP_MATRIX.makeScale(0, 0, 0) : this._tileMatrix(f));
      TMP_COLOR.copy(floorColor).multiplyScalar(f.shade * (((f.x + f.y) & 1) ? 1.0 : 0.96));
      if (state !== FLOOR_STATE.LIT) TMP_COLOR.lerp(this._skyColor, 0.55);
      this._floorMesh.setColorAt(f.index, TMP_COLOR);
    }
    for (const wt of this._wallTiles) {
      const idx = map.idx(wt.x, wt.y);
      const state = map.visible[idx] ? FLOOR_STATE.LIT : (map.explored[idx] ? FLOOR_STATE.DIM : FLOOR_STATE.HIDDEN);
      if (state === wt.state) continue;
      wt.state = state;
      wallChanged = true;
      this._wallMesh.setMatrixAt(wt.index, state === FLOOR_STATE.HIDDEN ? TMP_MATRIX.makeScale(0, 0, 0) : this._tileMatrix(wt));
      TMP_COLOR.copy(wallColor).multiplyScalar(wt.shade);
      if (state !== FLOOR_STATE.LIT) TMP_COLOR.lerp(this._skyColor, 0.55);
      this._wallMesh.setColorAt(wt.index, TMP_COLOR);
    }
    if (floorChanged) { this._floorMesh.instanceMatrix.needsUpdate = true; if (this._floorMesh.instanceColor) this._floorMesh.instanceColor.needsUpdate = true; }
    if (wallChanged) { this._wallMesh.instanceMatrix.needsUpdate = true; if (this._wallMesh.instanceColor) this._wallMesh.instanceColor.needsUpdate = true; }
  }

  _tileVisible(map, x, y) {
    if (!map) return false;
    const ix = Math.round(x), iy = Math.round(y);
    if (!map.inBounds(ix, iy)) return false;
    return !!map.visible[map.idx(ix, iy)];
  }

  _updateMarkers(dt) {
    const map = this.map;
    const seen = (root) => !!map && !!map.explored[map.idx(Math.round(root.position.x), Math.round(root.position.z))];
    if (this._entranceMarker) this._entranceMarker.root.visible = seen(this._entranceMarker.root);
    for (const m of this._exitMarkers) m.root.visible = seen(m.root);
    const markers = this._entranceMarker ? [this._entranceMarker, ...this._exitMarkers] : this._exitMarkers;
    for (const m of markers) {
      const s = Math.sin(this._time * (m.down ? 3 : 1.6) + m.phase);
      m.sign.position.y = 1.85 + s * (m.down ? 0.08 : 0.04);
      const pulse = m.down ? 1 + 0.35 * s : 1 + 0.1 * s;
      m.light.intensity = m.baseLight * pulse;
      if (m.glow) m.glow.material.opacity = 0.7 * (0.85 + 0.15 * s);
    }
  }

  _updateTorches(dt) {
    const map = this.map;
    if (map) for (const d of this._doorDecor) d.visible = !!map.explored[map.idx(d.position.x, d.position.z)];
    for (const t of this._torches) {
      t.root.visible = !!map && !!map.explored[map.idx(t.x, t.y)];
      if (!t.root.visible) continue;
      const f1 = Math.sin(this._time * 9 + t.phase), f2 = Math.sin(this._time * 23 + t.phase * 1.7);
      const flicker = 1.0 + 0.12 * f1 + 0.06 * f2;
      t.flame.scale.set(1 + 0.05 * f2, flicker, 1 + 0.05 * f1);
      t.flame.rotation.z = 0.08 * f2;
      t.glow.scale.setScalar(1.1 * (1 + 0.1 * f1 + 0.05 * f2));
    }
  }

  // ---------------------------------------------------------------- generic entry helpers
  _lerpEntry(entry, x, y, dt, speed = 18) {
    if (entry.vx === undefined) { entry.vx = x; entry.vy = y; }
    const dx = x - entry.vx, dy = y - entry.vy;
    const d = Math.hypot(dx, dy);
    if (d > 4) {
      entry.vx = x; entry.vy = y;
    } else if (d > 1e-4) {
      const step = Math.min(d, speed * dt);
      entry.vx += (dx / d) * step;
      entry.vy += (dy / d) * step;
    }
    entry.root.position.x = entry.vx;
    entry.root.position.z = entry.vy;
  }

  _rotateEntryTowards(entry, targetAngle, dt, speed = 14) {
    if (entry.angle === undefined) entry.angle = targetAngle;
    let diff = targetAngle - entry.angle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const maxStep = speed * dt;
    if (Math.abs(diff) <= maxStep) entry.angle = targetAngle;
    else entry.angle += Math.sign(diff) * maxStep;
    entry.root.rotation.y = entry.angle;
  }

  _setEntryOpacity(entry, val) {
    for (const m of entry.materials) m.opacity = val * (m.userData.baseOpacity ?? 1);
  }

  _removeEntry(entry) {
    if (entry.root) this.scene.remove(entry.root);
    if (entry.hpBarGroup) this.scene.remove(entry.hpBarGroup);
    if (entry.materials) for (const m of entry.materials) m.dispose();
    if (entry.extraMats) for (const m of entry.extraMats) m.dispose();
    if (entry.hpBarFg) entry.hpBarFg.material.dispose();
    if (entry.hpBarBg) entry.hpBarBg.material.dispose();
  }

  // ---------------------------------------------------------------- player
  // Model + walk/swing animation live in models.js. Entry contract: { root, materials, sword, cape, anim }.
  _buildPlayerMesh() {
    const entry = this.models.buildPlayer();
    entry.root.scale.setScalar(ENTITY_SCALE);
    return entry;
  }

  _updatePlayer(game, dt) {
    const p = game.player;
    if (!p) return;
    if (!this.playerEntry) {
      this.playerEntry = this._buildPlayerMesh();
      this.scene.add(this.playerEntry.root);
      this.playerEntry.vx = p.fx ?? p.x; this.playerEntry.vy = p.fy ?? p.y;
      this.playerEntry.angle = facingAngle(p.facing?.x || 0, p.facing?.y || 1);
    }
    const entry = this.playerEntry;
    // Held weapon / off-hand mirror the equipped items (rebuilt only when they change).
    this.models.syncPlayerEquipment(entry, p);
    const prevX = entry.vx, prevY = entry.vy;
    // fx/fy is the free-movement (analog) position; x/y is the tile it rounds to.
    this._lerpEntry(entry, p.fx ?? p.x, p.fy ?? p.y, dt);
    const moving = Math.hypot(entry.vx - prevX, entry.vy - prevY) > 0.001;
    const look = p.aim || p.facing;
    const targetAngle = facingAngle(look?.x || 0, look?.y || 1);
    this._rotateEntryTowards(entry, targetAngle, dt);

    this.models.animatePlayer(entry, dt, moving, this._time);

    this._applyHitFlash(entry, p.hitFlash || 0);
    this._applyInvuln(entry, p.invuln || 0);
  }

  _applyHitFlash(entry, hitFlash) {
    const t = Math.min(1, hitFlash / HIT_FLASH_WINDOW);
    for (const m of entry.materials) {
      if (t > 0) {
        m.emissive.copy(m.userData.baseEmissive).lerp(TMP_COLOR2.setHex(0xffffff), t * 0.85);
        m.emissiveIntensity = Math.max(m.userData.baseEmissiveIntensity || 0, t);
      } else {
        m.emissive.copy(m.userData.baseEmissive);
        m.emissiveIntensity = m.userData.baseEmissiveIntensity || 0;
      }
    }
  }

  _applyInvuln(entry, invuln) {
    if (invuln > 0) {
      const a = 0.45 + 0.35 * Math.sin(this._time * 22);
      this._setEntryOpacity(entry, THREE.MathUtils.clamp(a, 0.3, 0.9));
    } else {
      this._setEntryOpacity(entry, 1);
    }
  }

  // ---------------------------------------------------------------- enemy shapes
  // Every shape (and both bosses) is built in models.js; `anim` holds its animation handles plus
  // `kind`, `topY` (head height in model units, used for the health bar) and `shadow` (blob size).
  _buildEnemyVisual(enemy) {
    const shape = (enemy.visual && enemy.visual.shape) || 'blob';
    const scale = ((enemy.visual && enemy.visual.scale) || 1) * ENTITY_SCALE;
    const materials = [];
    const extraMats = [];
    const root = new THREE.Group();
    const anim = this.models.buildEnemy(enemy, root, materials, extraMats);
    if (anim.shadow) root.add(this._makeBlobShadow(anim.shadow));
    root.scale.setScalar(scale);

    if (enemy.elite) {
      // Elites: a slowly turning gold ring on the floor plus a floating gold gem over the head.
      const auraMat = new THREE.MeshBasicMaterial({ color: 0xffd34f, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
      auraMat.userData.baseOpacity = 0.7;
      const ring = new THREE.Mesh(this._geo.ring, auraMat);
      ring.rotation.x = -Math.PI / 2;
      ring.scale.set(0.65, 0.65, 1);
      ring.position.y = 0.03;
      root.add(ring);
      anim.aura = ring;
      extraMats.push(auraMat);
      this.models.addEliteMarker(root, anim, materials);
    }

    return { root, materials, extraMats, shape, anim, elite: !!enemy.elite, baseScale: scale, topY: anim.topY || 0.9 };
  }

  _animateEnemyEntry(entry, enemy, dt, moving) {
    this.models.animateEnemy(entry, enemy, dt, moving, this._time);
    if (entry.anim.aura) entry.anim.aura.rotation.z += dt * 0.9;
  }

  _applyStatusEffects(entry, enemy) {
    const frozen = enemy.frozen > 0 && !enemy._gallery, slow = !frozen && enemy.slow > 0;
    const flashAmt = Math.min(1, (enemy.hitFlash || 0) / HIT_FLASH_WINDOW);
    for (const m of entry.materials) {
      const base = m.userData.baseEmissive;
      let col = base;
      let intensity = m.userData.baseEmissiveIntensity || 0;
      if (frozen) { col = base.clone().lerp(TMP_COLOR.setHex(0x55c8ff), 0.6); intensity = Math.max(intensity, 0.9); }
      else if (slow) { col = base.clone().lerp(TMP_COLOR.setHex(0xaee0ff), 0.35); intensity = Math.max(intensity, 0.5); }
      if (flashAmt > 0) { col = (col === base ? col.clone() : col).lerp(TMP_COLOR2.setHex(0xffffff), flashAmt * 0.85); intensity = Math.max(intensity, flashAmt); }
      m.emissive.copy(col);
      m.emissiveIntensity = (frozen || slow || flashAmt > 0) ? intensity : (m.userData.baseEmissiveIntensity || 0);
    }
  }

  // Kicks off a brief recoil (mesh shoved away from the attacker, spring back) plus a
  // squash-and-stretch pop. Purely a visual offset on top of whatever _lerpEntry/knockback did —
  // never touches game state.
  _triggerHitReaction(entry, enemy) {
    const pe = this.playerEntry;
    const fromX = pe ? pe.vx : enemy.x, fromY = pe ? pe.vy : enemy.y;
    let dx = entry.vx - fromX, dy = entry.vy - fromY;
    const d = Math.hypot(dx, dy);
    if (d < 1e-3) { dx = enemy.facing?.x || 0; dy = enemy.facing?.y || 1; }
    else { dx /= d; dy /= d; }
    entry.hitRecoilDir = { x: dx, y: dy };
    entry.hitRecoilTime = HIT_RECOIL_DURATION;
    entry.hitSquashTime = HIT_SQUASH_DURATION;
  }

  _applyHitReaction(entry, dt) {
    if (entry.hitRecoilTime > 0) {
      entry.hitRecoilTime = Math.max(0, entry.hitRecoilTime - dt);
      const t = entry.hitRecoilTime / HIT_RECOIL_DURATION; // 1 -> 0
      const mag = HIT_RECOIL_DIST * t * t; // fast start, eases back to 0
      entry.root.position.x += entry.hitRecoilDir.x * mag;
      entry.root.position.z += entry.hitRecoilDir.y * mag;
    }
    let scaleY = 1, scaleXZ = 1;
    if (entry.hitSquashTime > 0) {
      entry.hitSquashTime = Math.max(0, entry.hitSquashTime - dt);
      const t = entry.hitSquashTime / HIT_SQUASH_DURATION; // 1 -> 0
      const amt = HIT_SQUASH_AMOUNT * t * t;
      scaleY = 1 - amt * 0.6;
      scaleXZ = 1 + amt * 0.6;
    }
    const base = entry.baseScale || 1;
    entry.root.scale.set(base * scaleXZ, base * scaleY, base * scaleXZ);
  }

  _animateEnemyDeath(entry, enemy) {
    if (entry.deathStart === undefined) entry.deathStart = Math.max(enemy.deathTimer || 0.4, 0.0001);
    const t = 1 - THREE.MathUtils.clamp((enemy.deathTimer || 0) / entry.deathStart, 0, 1);
    // A quick pop right at the moment of death, then a shrinking implosion — reads as a "pop"
    // instead of a plain fade/shrink.
    const shrink = Math.max(0, 1 - t);
    const pop = t < DEATH_POP_FRAC ? DEATH_POP_AMOUNT * (1 - t / DEATH_POP_FRAC) : 0;
    entry.root.scale.setScalar(Math.max(0.001, shrink + pop) * (entry.baseScale || 1));
    entry.root.position.y = -t * 0.6;
    for (const m of entry.materials) m.opacity = Math.max(0, (m.userData.baseOpacity ?? 1) * (1 - t));
    for (const m of entry.extraMats) {
      if (m.userData.baseOpacity === undefined) m.userData.baseOpacity = m.opacity;
      m.opacity = Math.max(0, m.userData.baseOpacity * (1 - t));
    }
    if (entry.hpBarGroup) entry.hpBarGroup.visible = false;
  }

  _buildHealthBar() {
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.75, depthTest: false });
    const fgMat = new THREE.MeshBasicMaterial({ color: 0x55ff55, transparent: true, opacity: 0.95, depthTest: false });
    const bg = new THREE.Mesh(this._geo.plane, bgMat);
    bg.scale.set(0.62, 0.09, 1);
    const fg = new THREE.Mesh(this._geo.plane, fgMat);
    fg.scale.set(0.6, 0.06, 1);
    fg.position.z = 0.001;
    const group = new THREE.Group();
    group.renderOrder = 10;
    group.add(bg, fg);
    this.scene.add(group);
    return { group, fg, bg };
  }

  _updateHealthBar(entry, enemy) {
    if (!entry.hpBarGroup) return;
    const frac = enemy.maxHp > 0 ? THREE.MathUtils.clamp(enemy.hp / enemy.maxHp, 0, 1) : 1;
    entry.hpBarFg.scale.x = 0.6 * frac;
    entry.hpBarFg.position.x = -0.3 * (1 - frac);
    entry.hpBarFg.material.color.setRGB(1 - frac, frac, 0.08);
    const scaleUp = entry.elite ? 1.25 : (entry.shape === 'boss' ? 1.5 : 1);
    // Sit just above the model's head (and the elite gem), following hovering/hopping bodies.
    const top = (entry.topY || 0.9) + (entry.elite ? 0.42 : 0.16);
    entry.hpBarGroup.scale.setScalar(scaleUp);
    entry.hpBarGroup.position.set(entry.vx, top * (entry.baseScale || 1) + 0.08 + Math.max(0, entry.root.position.y), entry.vy);
    entry.hpBarGroup.quaternion.copy(this.camera.quaternion);
    if (entry.elite) entry.hpBarBg.material.color.setHex(0x554010);
  }

  _syncEnemies(game, dt) {
    const list = game.enemies || [];
    const seen = new Set();
    const map = game.map;
    for (const enemy of list) {
      seen.add(enemy.id);
      let entry = this.enemyEntries.get(enemy.id);
      if (!entry) {
        entry = this._buildEnemyVisual(enemy);
        const bar = this._buildHealthBar();
        entry.hpBarGroup = bar.group; entry.hpBarFg = bar.fg; entry.hpBarBg = bar.bg;
        this.scene.add(entry.root);
        this.enemyEntries.set(enemy.id, entry);
        entry.vx = enemy.x; entry.vy = enemy.y;
        entry.angle = facingAngle(enemy.facing?.x || 0, enemy.facing?.y || 1);
      }
      const visible = this._tileVisible(map, enemy.x, enemy.y) || this._tileVisible(map, entry.vx, entry.vy);
      entry.root.visible = visible;
      // Bosses show their HP in the top-of-screen HUD bar instead — the overhead bar would
      // just duplicate it.
      if (entry.hpBarGroup) entry.hpBarGroup.visible = visible && !enemy.dead && enemy.hp < enemy.maxHp && entry.shape !== 'boss';
      if (!visible) continue;

      if (enemy.dead) {
        this._animateEnemyDeath(entry, enemy);
        continue;
      }

      // A fresh hit (hitFlash just reset) kicks off a recoil + squash pop, independent of any
      // tile knockback — this fires on every hit, including ones that don't move the enemy.
      const flash = enemy.hitFlash || 0;
      if (flash > (entry._prevHitFlash || 0) + 1e-6) this._triggerHitReaction(entry, enemy);
      entry._prevHitFlash = flash;

      // A fresh tile-knockback (enemy._kbTime just (re)set by game.damageEnemy) is animated as a
      // fast-start/ease-out shove instead of the generic constant-speed lerp.
      const kbTime = enemy._kbTime || 0;
      if (kbTime > (entry._prevKbTime || 0) + 1e-6) {
        entry._kbFromX = entry.vx; entry._kbFromY = entry.vy;
        entry._kbToX = enemy.x; entry._kbToY = enemy.y;
        entry._kbDuration = kbTime;
      }
      entry._prevKbTime = kbTime;

      // Slime King's Hop Slam: a fresh boss leap (enemy._hopTime just (re)set by enemies.js)
      // is animated as an arc from the takeoff tile to the landing tile, overriding both the
      // knockback ease and the generic lerp for its duration.
      const hopTime = enemy._hopTime || 0;
      if (hopTime > (entry._prevHopTime || 0) + 1e-6) {
        const from = enemy._hopFrom || { x: entry.vx, y: entry.vy };
        entry._hopFromX = from.x; entry._hopFromY = from.y;
        entry._hopToX = enemy.x; entry._hopToY = enemy.y;
        entry._hopDuration = enemy._hopDur || hopTime;
      }
      entry._prevHopTime = hopTime;

      const prevX = entry.vx, prevY = entry.vy;
      if (hopTime > 0 && entry._hopDuration) {
        const t = THREE.MathUtils.clamp(1 - hopTime / entry._hopDuration, 0, 1);
        entry.vx = THREE.MathUtils.lerp(entry._hopFromX, entry._hopToX, t);
        entry.vy = THREE.MathUtils.lerp(entry._hopFromY, entry._hopToY, t);
        entry.root.position.x = entry.vx;
        entry.root.position.z = entry.vy;
        entry._hopArcY = Math.sin(Math.PI * t) * 0.9;
      } else if (kbTime > 0 && entry._kbDuration) {
        const t = THREE.MathUtils.clamp(1 - kbTime / entry._kbDuration, 0, 1);
        const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic: fast start, settles at the end
        entry.vx = THREE.MathUtils.lerp(entry._kbFromX, entry._kbToX, eased);
        entry.vy = THREE.MathUtils.lerp(entry._kbFromY, entry._kbToY, eased);
        entry.root.position.x = entry.vx;
        entry.root.position.z = entry.vy;
        entry._hopArcY = 0;
      } else {
        entry._hopArcY = 0;
        this._lerpEntry(entry, enemy.x, enemy.y, dt, 16);
      }
      const moved = Math.hypot(entry.vx - prevX, entry.vy - prevY) > 0.001;
      const targetAngle = facingAngle(enemy.facing?.x || 0, enemy.facing?.y || 1);
      this._rotateEntryTowards(entry, targetAngle, dt);
      this._applyStatusEffects(entry, enemy);
      this._animateEnemyEntry(entry, enemy, dt, moved);
      this._applyHitReaction(entry, dt);
      this._updateHealthBar(entry, enemy);
    }
    for (const [id, entry] of this.enemyEntries) {
      if (!seen.has(id)) { this._removeEntry(entry); this.enemyEntries.delete(id); }
    }
  }

  // ---------------------------------------------------------------- npcs (merchant)
  // A travelling merchant (models.js): feathered hat, overstuffed backpack, swinging lantern, wares on
  // a rug, and a bobbing/spinning coin above so the tile reads as "shop" from the top-down camera.
  _buildNpcVisual(npc) {
    const entry = this.models.buildMerchant();
    entry.root.scale.setScalar(ENTITY_SCALE);
    return entry;
  }

  _syncNpcs(game, dt) {
    const list = game.npcs || [];
    const seen = new Set();
    const map = game.map;
    for (const npc of list) {
      seen.add(npc.id);
      let entry = this.npcEntries.get(npc.id);
      if (!entry) {
        entry = this._buildNpcVisual(npc);
        this.scene.add(entry.root);
        this.npcEntries.set(npc.id, entry);
      }
      entry.root.position.set(npc.x, 0, npc.y);
      const visible = this._tileVisible(map, npc.x, npc.y);
      entry.root.visible = visible;
      if (!visible) continue;
      this.models.animateMerchant(entry, npc, game.player, dt);
    }
    for (const [id, entry] of this.npcEntries) {
      if (!seen.has(id)) { this._removeEntry(entry); this.npcEntries.delete(id); }
    }
  }

  // ---------------------------------------------------------------- ground items
  // Layout: root (tile position) -> floor pad (rarity-colored ring + glow) + float group (bob)
  //   -> pivot (tilted toward the camera, gentle sway) -> type-specific model.
  _buildItemVisual(item) {
    const root = new THREE.Group();
    const materials = [];
    const type = item ? item.type : 'gold';

    let padColor;
    if (type === 'gold') padColor = new THREE.Color(0xffc93d);
    else if (type === 'potion') padColor = new THREE.Color(this._isManaPotion(item) ? 0x3aa0ff : 0xff4d4d);
    else padColor = new THREE.Color(item.rarity === 'common' ? 0xffffff : (RARITY[item.rarity] || RARITY.common).color);

    // Floor pad: soft colored glow, translucent disc, crisp ring.
    const padMat = (opts) => {
      const m = new THREE.MeshBasicMaterial(Object.assign({ color: padColor, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }, opts));
      materials.push(m);
      return m;
    };
    const glow = new THREE.Mesh(this._geo.blob, padMat({ map: this._tex.glow, opacity: 0.75 }));
    glow.scale.set(1.25, 1, 1.25); glow.position.y = 0.014;
    const disc = new THREE.Mesh(this._geo.lootDisc, padMat({ opacity: 0.22 }));
    disc.scale.setScalar(0.78); disc.position.y = 0.016;
    const ring = new THREE.Mesh(this._geo.lootRing, padMat({ opacity: 0.95 }));
    ring.scale.setScalar(0.82); ring.position.y = 0.018;
    root.add(glow, disc, ring);

    const float = new THREE.Group();
    const pivot = new THREE.Group();
    pivot.rotation.x = -0.75; // lean toward the camera so the silhouette reads from above
    float.add(pivot);
    root.add(float);
    pivot.add(this._buildItemModel(item, type, materials));

    // Light beam for rare and better; taller with rarity.
    let beamMat = null;
    const beamHeight = { rare: 1.1, epic: 1.9, legendary: 2.8 }[item && item.rarity];
    if (beamHeight && type !== 'potion' && type !== 'gold') {
      beamMat = new THREE.MeshBasicMaterial({ color: padColor, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
      materials.push(beamMat);
      // Starts above the model so it never covers the item's silhouette.
      const beam = new THREE.Mesh(this._geo.cylinder, beamMat);
      beam.scale.set(0.16, beamHeight, 0.16);
      beam.position.y = 0.8 + beamHeight / 2;
      root.add(beam);
    }
    return { root, materials, float, pivot, ring, glow, beamMat, phase: Math.random() * 10 };
  }

  _isManaPotion(item) {
    return !!(item && item.potion && item.potion.mana > 0 && !(item.potion.heal > 0));
  }

  // Item model, roughly 0.6 tiles tall, centered on the origin, facing +z.
  _buildItemModel(item, type, materials) {
    const g = new THREE.Group();
    const geo = this._geo;
    const add = (geom, mat, s, p, r) => {
      const mesh = new THREE.Mesh(geom, mat);
      mesh.scale.set(s[0], s[1], s[2]);
      if (p) mesh.position.set(p[0], p[1], p[2]);
      if (r) mesh.rotation.set(r[0], r[1], r[2]);
      g.add(mesh);
      return mesh;
    };
    const rarity = item && item.rarity;
    const accentColor = rarity && rarity !== 'common' ? (RARITY[rarity] || RARITY.common).color : 0x9fb4c8;
    const accent = this._newMat(accentColor, { emissive: accentColor, emissiveIntensity: 0.45, metalness: 0.3, roughness: 0.3 }, materials);
    const steel = this._newMat(0xe3e8ef, { metalness: 0.75, roughness: 0.25, emissive: 0x2a2f38, emissiveIntensity: 0.4 }, materials);
    const dark = this._newMat(0x4a4f5e, { metalness: 0.6, roughness: 0.4 }, materials);
    const wood = this._newMat(0x8a5a34, { roughness: 0.8 }, materials);
    const leather = this._newMat(0x9a6233, { roughness: 0.85 }, materials);
    const gold = this._newMat(0xffd23f, { emissive: 0xb07800, emissiveIntensity: 0.55, metalness: 0.25, roughness: 0.35 }, materials);

    const kind = item && (item.weaponKind || item.offhandKind);
    switch (kind || type) {
      case 'gold':
        for (let i = 0; i < 6; i++) {
          const a = i * 2.1;
          const rad = i < 3 ? 0.1 : 0.04;
          add(geo.cylinder, gold, [0.22, 0.05, 0.22], [Math.cos(a) * rad, -0.14 + i * 0.05, Math.sin(a) * rad], [0.25 * Math.sin(i), 0, 0.2 * Math.cos(i)]);
        }
        add(geo.cylinder, gold, [0.24, 0.05, 0.24], [0.05, 0.08, 0.08], [Math.PI / 2 - 0.3, 0, 0.2]); // standing coin, catches the eye
        break;
      case 'potion': {
        const liquid = this._isManaPotion(item) ? 0x3aa0ff : 0xe23a3a;
        const liquidMat = this._newMat(liquid, { emissive: liquid, emissiveIntensity: 0.55, roughness: 0.25 }, materials);
        const glass = this._newMat(0xdff4ff, { opacity: 0.5, roughness: 0.1, metalness: 0.1 }, materials);
        add(geo.sphereLow, liquidMat, [0.3, 0.3, 0.3], [0, -0.06, 0]);
        add(geo.cylinder, glass, [0.11, 0.16, 0.11], [0, 0.15, 0]);
        add(geo.cylinder, this._newMat(0x8a6a3a, { roughness: 0.9 }, materials), [0.12, 0.07, 0.12], [0, 0.26, 0]);
        add(geo.sphereLow, this._newMat(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.6 }, materials), [0.07, 0.07, 0.04], [-0.07, 0.0, 0.12]);
        break;
      }
      case 'sword':
      case 'dagger': {
        const k = kind === 'dagger' ? 0.7 : 1;
        add(geo.box, steel, [0.1 * k, 0.5 * k, 0.03], [0, 0.12 * k, 0]);
        add(geo.cone, steel, [0.1 * k, 0.1 * k, 0.03], [0, 0.42 * k, 0]);
        add(geo.box, gold, [0.3 * k, 0.06, 0.07], [0, -0.14 * k, 0]);
        add(geo.cylinder, leather, [0.06, 0.16 * k, 0.06], [0, -0.25 * k, 0]);
        add(geo.sphereLow, accent, [0.1, 0.1, 0.1], [0, -0.35 * k, 0]);
        g.rotation.z = -Math.PI / 4;
        break;
      }
      case 'axe':
        add(geo.cylinder, wood, [0.07, 0.72, 0.07]);
        add(geo.box, steel, [0.28, 0.24, 0.05], [0.12, 0.2, 0]);
        add(geo.cylinder, steel, [0.3, 0.05, 0.3], [0.24, 0.2, 0], [0, 0, Math.PI / 2]);
        add(geo.box, accent, [0.09, 0.09, 0.08], [0, 0.2, 0]);
        g.rotation.z = -Math.PI / 5;
        break;
      case 'mace':
        add(geo.cylinder, wood, [0.07, 0.6, 0.07], [0, -0.08, 0]);
        add(geo.sphereLow, dark, [0.26, 0.26, 0.26], [0, 0.26, 0]);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          add(geo.cone, steel, [0.08, 0.14, 0.08], [Math.cos(a) * 0.14, 0.26, Math.sin(a) * 0.14], [0, -a, -Math.PI / 2]);
        }
        add(geo.cone, steel, [0.08, 0.14, 0.08], [0, 0.42, 0]);
        add(geo.torus, accent, [0.2, 0.2, 0.3], [0, 0.12, 0], [Math.PI / 2, 0, 0]);
        g.rotation.z = -Math.PI / 5;
        break;
      case 'staff':
        add(geo.cylinder, wood, [0.06, 0.8, 0.06], [0, -0.05, 0]);
        add(geo.torus, gold, [0.2, 0.2, 0.3], [0, 0.36, 0]);
        add(geo.sphereLow, accent, [0.18, 0.18, 0.18], [0, 0.4, 0]);
        g.rotation.z = -Math.PI / 6;
        break;
      case 'bow':
        add(geo.bowArc, wood, [0.36, 0.5, 0.5], null, [0, 0, -Math.PI / 2]);
        add(geo.box, this._newMat(0xf4f1e6, { roughness: 0.6 }, materials), [0.015, 0.72, 0.015]);
        add(geo.box, accent, [0.08, 0.12, 0.08], [0.18, 0, 0]);
        g.rotation.z = -Math.PI / 8;
        break;
      case 'shield':
        add(geo.cylinder, wood, [0.56, 0.07, 0.56], null, [Math.PI / 2, 0, 0]);
        add(geo.torus, steel, [0.56, 0.56, 0.6]);
        add(geo.sphereLow, accent, [0.16, 0.16, 0.1], [0, 0, 0.05]);
        break;
      case 'orb':
        add(geo.sphereLow, accent, [0.36, 0.36, 0.36], [0, 0.06, 0]);
        add(geo.cylinder, gold, [0.2, 0.08, 0.2], [0, -0.16, 0]);
        add(geo.torus, gold, [0.28, 0.28, 0.4], [0, -0.1, 0], [Math.PI / 2, 0, 0]);
        break;
      case 'tome':
        add(geo.box, this._newMat(0x7a2a3a, { roughness: 0.7 }, materials), [0.44, 0.52, 0.12]);
        add(geo.box, this._newMat(0xfaf3dd, { roughness: 0.9 }, materials), [0.4, 0.48, 0.13], [0.03, 0, 0]);
        add(geo.box, gold, [0.06, 0.52, 0.13], [-0.2, 0, 0]);
        add(geo.sphereLow, accent, [0.13, 0.13, 0.06], [0, 0, 0.07]);
        break;
      case 'helm':
        add(geo.sphereLow, steel, [0.44, 0.4, 0.44], [0, 0.02, 0]);
        add(geo.torus, dark, [0.44, 0.44, 0.5], [0, -0.08, 0], [Math.PI / 2, 0, 0]);
        add(geo.box, dark, [0.3, 0.07, 0.05], [0, 0.0, 0.2]);
        add(geo.box, accent, [0.06, 0.24, 0.26], [0, 0.26, -0.02]);
        break;
      case 'armor':
        add(geo.box, steel, [0.42, 0.44, 0.2]);
        add(geo.sphereLow, steel, [0.2, 0.16, 0.22], [-0.24, 0.18, 0]);
        add(geo.sphereLow, steel, [0.2, 0.16, 0.22], [0.24, 0.18, 0]);
        add(geo.box, leather, [0.44, 0.07, 0.22], [0, -0.14, 0]);
        add(geo.sphereLow, accent, [0.12, 0.12, 0.06], [0, 0.06, 0.1]);
        break;
      case 'boots':
        for (const sx of [-0.12, 0.12]) {
          add(geo.box, leather, [0.14, 0.3, 0.16], [sx, 0.04, 0]);
          add(geo.box, leather, [0.14, 0.1, 0.28], [sx, -0.14, 0.07]);
          add(geo.box, accent, [0.16, 0.05, 0.18], [sx, 0.17, 0]);
        }
        break;
      case 'ring':
        add(geo.torus, gold, [0.38, 0.38, 0.6]);
        add(geo.sphereLow, accent, [0.16, 0.16, 0.16], [0, 0.22, 0]);
        break;
      case 'amulet':
        add(geo.torus, gold, [0.44, 0.44, 0.3], [0, 0.08, 0]);
        add(geo.box, gold, [0.12, 0.14, 0.05], [0, -0.18, 0], [0, 0, Math.PI / 4]);
        add(geo.sphereLow, accent, [0.16, 0.16, 0.1], [0, -0.18, 0.03]);
        break;
      default:
        add(geo.sphereLow, accent, [0.3, 0.36, 0.3]);
    }
    g.scale.setScalar(1.2);
    return g;
  }

  _syncItems(game, dt) {
    const list = game.groundItems || [];
    const seen = new Set();
    const map = game.map;
    const perTile = new Map();
    for (const gi of list) {
      seen.add(gi.id);
      let entry = this.itemEntries.get(gi.id);
      if (!entry) {
        entry = this._buildItemVisual(gi.item);
        this.scene.add(entry.root);
        this.itemEntries.set(gi.id, entry);
      }
      // Fan out items sharing a tile so each stays readable.
      const key = gi.x + ',' + gi.y;
      const n = perTile.get(key) || 0;
      perTile.set(key, n + 1);
      const fan = n === 0 ? 0 : 0.26;
      const fanA = n * 2.4;
      entry.root.position.set(gi.x + Math.cos(fanA) * fan, 0, gi.y + Math.sin(fanA) * fan);
      const visible = this._tileVisible(map, gi.x, gi.y);
      entry.root.visible = visible;
      if (!visible) continue;
      entry.phase += dt;
      const t = entry.phase;
      entry.float.position.y = 0.42 + Math.sin(t * 2.2) * 0.07;
      entry.pivot.rotation.y = Math.sin(t * 1.3) * 0.45;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3);
      entry.ring.scale.setScalar(0.78 + pulse * 0.08);
      entry.ring.material.opacity = 0.7 + pulse * 0.3;
      entry.glow.material.opacity = 0.55 + pulse * 0.3;
      if (entry.beamMat) entry.beamMat.opacity = 0.3 + 0.15 * Math.sin(t * 3);
    }
    for (const [id, entry] of this.itemEntries) {
      if (!seen.has(id)) { this._removeEntry(entry); this.itemEntries.delete(id); }
    }
  }

  // ---------------------------------------------------------------- projectiles
  _buildProjectileVisual(p) {
    const root = new THREE.Group();
    const materials = [];
    const color = new THREE.Color(p.color || (p.kind === 'enemyBolt' ? '#ff4444' : '#66ccff'));
    const coreMat = this._newMat(color, { emissive: color, emissiveIntensity: 1.4 }, materials);
    const size = THREE.MathUtils.clamp(p.size || 0.2, 0.08, 0.6);
    const core = new THREE.Mesh(this._geo.sphereLow, coreMat);
    if (p.kind === 'arrow') core.scale.set(size * 0.5, size * 0.5, size * 2.2);
    else core.scale.set(size, size, size * (p.kind === 'fireball' ? 1.3 : 1));
    root.add(core);
    const trailMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
    const trail = new THREE.Mesh(this._geo.cone, trailMat);
    trail.rotation.x = Math.PI / 2;
    trail.scale.set(size * 0.7, size * 3.2, size * 0.7);
    trail.position.z = -size * 1.6;
    root.add(trail);
    materials.push(trailMat);
    root.position.y = 0.4;
    return { root, materials, coreMat, pulsePhase: 0 };
  }

  _syncProjectiles(game, dt) {
    const list = game.projectiles || [];
    const seen = new Set();
    const map = game.map;
    for (const p of list) {
      seen.add(p.id);
      let entry = this.projectileEntries.get(p.id);
      if (!entry) {
        entry = this._buildProjectileVisual(p);
        this.scene.add(entry.root);
        this.projectileEntries.set(p.id, entry);
      }
      entry.root.position.x = p.x;
      entry.root.position.z = p.y;
      entry.root.rotation.y = facingAngle(p.dx || 0, p.dy || 1);
      const visible = this._tileVisible(map, p.x, p.y);
      entry.root.visible = visible;
      if (visible) {
        entry.pulsePhase += dt * 20;
        if (entry.coreMat) entry.coreMat.emissiveIntensity = 1.2 + 0.5 * Math.sin(entry.pulsePhase);
      }
    }
    for (const [id, entry] of this.projectileEntries) {
      if (!seen.has(id)) { this._removeEntry(entry); this.projectileEntries.delete(id); }
    }
  }

  // ================================================================== effects
  _updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.age += dt;
      const t = THREE.MathUtils.clamp(fx.age / fx.duration, 0, 1);
      fx.update(t, dt, fx.age);
      if (fx.age >= fx.duration) {
        this._disposeEffect(fx);
        this.effects.splice(i, 1);
      }
    }
  }

  _disposeEffect(fx) {
    if (fx.obj) this.scene.remove(fx.obj);
    if (fx.extra) this.scene.remove(fx.extra);
    if (fx.mats) for (const m of fx.mats) m.dispose();
    if (fx.geo) fx.geo.dispose();
  }

  spawnEffect(type, x, y, opts = {}) {
    switch (type) {
      case 'slash':
        this._fxSlash(x, y, opts);
        if (this.playerEntry) this.playerEntry.swingT = SWING_DURATION; // hero swings the held weapon
        break;
      case 'nova': this._fxNova(x, y, opts); break;
      case 'dash': this._fxDash(x, y, opts); break;
      case 'hit': {
        const crit = !!opts.crit;
        this._fxBurst(x, y, {
          color: opts.color || '#ffdd88',
          count: crit ? CRIT_BURST_COUNT : HIT_BURST_COUNT,
          speed: crit ? CRIT_BURST_SPEED : HIT_BURST_SPEED,
          size: crit ? CRIT_BURST_SIZE : HIT_BURST_SIZE,
          duration: 0.35, gravity: 0,
        });
        if (crit) this._fxCritFlash(x, y);
        break;
      }
      case 'death': this._fxBurst(x, y, { color: opts.color || '#ff5555', count: 18, speed: 3.2, size: 0.12, duration: 0.6, gravity: 3 }); break;
      case 'levelup': this._fxLevelup(x, y, opts); break;
      case 'heal': this._fxBurst(x, y, { color: opts.color || '#55ff88', count: 14, speed: 1.0, size: 0.09, duration: 0.9, gravity: -1.0 }); break;
      case 'pickup': this._fxBurst(x, y, { color: opts.color || '#ffffff', count: 6, speed: 1.0, size: 0.06, duration: 0.35, gravity: -0.5 }); break;
      case 'exit': this._fxNova(x, y, { radius: opts.radius || 3, color: this._theme ? this._theme.accent : 0x8fe0ff }); this.shake(0.15); break;
      case 'telegraphCircle': this._fxTelegraphCircle(x, y, opts); break;
      case 'telegraphLine': this._fxTelegraphLine(x, y, opts); break;
      default: break;
    }
  }

  // A red ground disc + outline ring that fills in over `duration`, then a quick bright
  // flash right as the attack detonates. Boss AoE telegraphs (e.g. Slime King's Hop Slam).
  _fxTelegraphCircle(x, y, opts = {}) {
    const radius = opts.radius || 1.5;
    const duration = opts.duration || 0.8;
    const color = new THREE.Color(opts.color !== undefined ? opts.color : 0xff3b3b);
    const fillMat = this._telegraphFillMatTpl.clone();
    fillMat.color.copy(color);
    const fill = new THREE.Mesh(this._geo.telegraphDisc, fillMat);
    fill.position.set(x, 0.02, y);
    fill.scale.setScalar(0.001);
    const ringMat = this._telegraphRingMatTpl.clone();
    ringMat.color.copy(color);
    const ring = new THREE.Mesh(this._geo.telegraphRing, ringMat);
    ring.position.set(x, 0.021, y);
    ring.scale.setScalar(radius);
    this.scene.add(fill, ring);
    this.effects.push({
      obj: fill, extra: ring, mats: [fillMat, ringMat], age: 0, duration, update: (t) => {
        if (t < 0.88) {
          const grow = t / 0.88;
          fill.scale.setScalar(Math.max(0.001, radius * grow));
          fillMat.opacity = 0.24 + 0.2 * grow;
          ringMat.opacity = 0.5 + 0.35 * grow;
        } else {
          const ft = (t - 0.88) / 0.12;
          fill.scale.setScalar(radius * (1 + ft * 0.25));
          fillMat.opacity = Math.max(0, 0.7 * (1 - ft));
          fillMat.color.lerp(TMP_COLOR2.setHex(0xffffff), ft * 0.6);
          ringMat.opacity = Math.max(0, 0.9 * (1 - ft));
        }
      },
    });
  }

  // Same idea as the circle telegraph, but a growing line from (x,y) out along (dx,dy) for
  // `length` tiles. Boss line/lane telegraphs (Bone Tyrant's spears and charge lane).
  _fxTelegraphLine(x, y, opts = {}) {
    const dx = opts.dx ?? 0, dy = opts.dy ?? 1;
    const dlen = Math.hypot(dx, dy) || 1;
    const ux = dx / dlen, uy = dy / dlen;
    const length = opts.length || 5;
    const width = opts.width || 1;
    const duration = opts.duration || 0.8;
    const color = new THREE.Color(opts.color !== undefined ? opts.color : 0xff3b3b);
    const angle = Math.atan2(ux, uy); // matches facingAngle()'s convention used elsewhere
    const fillMat = this._telegraphFillMatTpl.clone();
    fillMat.color.copy(color);
    const mesh = new THREE.Mesh(this._geo.box, fillMat);
    mesh.rotation.y = angle;
    mesh.position.set(x, 0.02, y);
    mesh.scale.set(width, 0.03, 0.001);
    this.scene.add(mesh);
    this.effects.push({
      obj: mesh, mats: [fillMat], age: 0, duration, update: (t) => {
        let curLen, opac;
        if (t < 0.85) {
          const grow = t / 0.85;
          curLen = Math.max(0.001, length * grow);
          opac = 0.32 + 0.22 * grow;
        } else {
          const ft = (t - 0.85) / 0.15;
          curLen = length * (1 + ft * 0.08);
          opac = Math.max(0, 0.75 * (1 - ft));
          fillMat.color.lerp(TMP_COLOR2.setHex(0xffffff), ft * 0.6);
        }
        mesh.scale.set(width, 0.03, curLen);
        mesh.position.set(x + ux * curLen / 2, 0.02, y + uy * curLen / 2);
        fillMat.opacity = opac;
      },
    });
  }

  _fxSlash(x, y, opts) {
    const dir = opts.dir || { x: 0, y: 1 };
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(this._geo.arc, mat);
    // The arc's midpoint lies on local +x; after the -90° X tilt, local (a, b) lands on world (a, -b) in x/z,
    // so rotate local +x onto (dir.x, -dir.y) to point the arc along the facing direction.
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.atan2(-dir.y, dir.x);
    // (x, y) is the tile in front of the player. Center the arc on the player's *rendered* position
    // so it sweeps outward around the struck tiles and stays attached while the model is still sliding.
    const fallbackX = x - dir.x, fallbackY = y - dir.y;
    const place = () => {
      const pe = this.playerEntry;
      mesh.position.set(pe ? pe.vx : fallbackX, 0.2, pe ? pe.vy : fallbackY);
    };
    place();
    mesh.scale.set(1.05, 1.05, 1);
    this.scene.add(mesh);
    this.effects.push({
      obj: mesh, mats: [mat], age: 0, duration: 0.22, update: (t) => {
        place();
        const s = 1.05 + 0.35 * t;
        mesh.scale.set(s, s, 1);
        mat.opacity = 0.9 * (1 - t);
      },
    });
  }

  _fxNova(x, y, opts) {
    const radius = opts.radius || 2.5;
    const color = new THREE.Color(opts.color !== undefined ? opts.color : 0x8fe0ff);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(this._geo.ring, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.08, y);
    mesh.scale.set(0.01, 0.01, 1);
    this.scene.add(mesh);
    const diskMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const disk = new THREE.Mesh(this._geo.ring, diskMat);
    disk.rotation.x = -Math.PI / 2; disk.position.set(x, 0.06, y); disk.scale.set(0.01, 0.01, 1);
    this.scene.add(disk);
    this.effects.push({
      obj: mesh, extra: disk, mats: [mat, diskMat], age: 0, duration: 0.5, update: (t) => {
        const s = THREE.MathUtils.lerp(0.1, radius / 0.675, t);
        mesh.scale.set(s, s, 1);
        disk.scale.set(s * 1.02, s * 1.02, 1);
        mat.opacity = 0.8 * (1 - t);
        diskMat.opacity = 0.2 * (1 - t);
      },
    });
  }

  _fxDash(x, y, opts) {
    const from = opts.from || { x, y };
    const steps = 5;
    const group = new THREE.Group();
    const ghosts = [];
    const mats = [];
    for (let i = 0; i < steps; i++) {
      const t0 = i / (steps - 1);
      const gx = THREE.MathUtils.lerp(from.x, x, t0);
      const gy = THREE.MathUtils.lerp(from.y, y, t0);
      const m = new THREE.MeshBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(this._geo.box, m);
      mesh.scale.set(0.3, 0.5, 0.22);
      mesh.position.set(gx, 0.3, gy);
      group.add(mesh);
      mats.push(m);
      ghosts.push({ mat: m, delay: t0 * 0.5 });
    }
    this.scene.add(group);
    this.effects.push({
      obj: group, mats, age: 0, duration: 0.28, update: (t) => {
        for (const g of ghosts) {
          const lt = THREE.MathUtils.clamp((t - g.delay) / (1 - g.delay + 0.001), 0, 1);
          g.mat.opacity = 0.5 * (1 - lt);
        }
      },
    });
  }

  _fxBurst(x, y, opt) {
    const { color = '#ffffff', count = 10, speed = 2, size = 0.1, duration = 0.4, gravity = 0 } = opt;
    const c = new THREE.Color(color);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const velocities = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = x; positions[i * 3 + 1] = 0.3; positions[i * 3 + 2] = y;
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      const ang = Math.random() * Math.PI * 2;
      const el = Math.random() * Math.PI * 0.5;
      const s = speed * (0.5 + Math.random() * 0.7);
      velocities.push({ vx: Math.cos(ang) * Math.cos(el) * s, vy: Math.sin(el) * s * 1.2, vz: Math.sin(ang) * Math.cos(el) * s });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = this._particleMat.clone();
    mat.size = size;
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.effects.push({
      obj: points, mats: [mat], geo, age: 0, duration, update: (t, dtStep) => {
        const pos = geo.attributes.position;
        for (let i = 0; i < count; i++) {
          const v = velocities[i];
          v.vy -= gravity * dtStep;
          pos.array[i * 3] += v.vx * dtStep;
          pos.array[i * 3 + 1] += v.vy * dtStep;
          pos.array[i * 3 + 2] += v.vz * dtStep;
        }
        pos.needsUpdate = true;
        mat.opacity = 1 - t;
      },
    });
  }

  // Small bright pop layered on top of the hit burst so crits read as extra punchy.
  _fxCritFlash(x, y) {
    const mat = new THREE.SpriteMaterial({
      map: this._tex.glow, color: 0xfff3b0, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.position.set(x, 0.5, y);
    spr.scale.setScalar(0.3);
    this.scene.add(spr);
    this.effects.push({
      obj: spr, mats: [mat], age: 0, duration: CRIT_FLASH_DURATION, update: (t) => {
        spr.scale.setScalar(THREE.MathUtils.lerp(0.3, 1.5, t));
        mat.opacity = 0.9 * (1 - t);
      },
    });
  }

  _fxLevelup(x, y) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd34f, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    const beam = new THREE.Mesh(this._geo.cylinder, mat);
    beam.scale.set(0.4, 2.2, 0.4);
    beam.position.set(x, 1.1, y);
    this.scene.add(beam);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(this._geo.ring, ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.1, y); ring.scale.set(0.1, 0.1, 1);
    this.scene.add(ring);
    this.effects.push({
      obj: beam, extra: ring, mats: [mat, ringMat], age: 0, duration: 1.0, update: (t) => {
        mat.opacity = 0.7 * (1 - t);
        beam.position.y = 1.1 + t * 0.6;
        const s = THREE.MathUtils.lerp(0.2, 2.5, t);
        ring.scale.set(s, s, 1);
        ringMat.opacity = 0.8 * (1 - t);
      },
    });
  }

  // ---------------------------------------------------------------- float text
  floatText(x, y, text, color) {
    if (this._floatTexts.length >= this._floatTextCap) {
      const old = this._floatTexts.shift();
      if (old) old.el.remove();
    }
    const str = String(text);
    const crit = str.includes('!');
    const el = document.createElement('div');
    el.textContent = str;
    const size = crit ? 22 : 15;
    el.style.cssText = `position:absolute;left:0;top:0;transform:translate(-50%,-50%);font-family:Fredoka,Nunito,Arial,sans-serif;font-weight:700;white-space:nowrap;pointer-events:none;color:${color || '#ffffff'};text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 2px 4px rgba(0,0,0,0.7);font-size:${size}px;`;
    this.overlay.appendChild(el);
    this._floatTexts.push({ el, wx: x, wy: y, wz: 0.9, age: 0, duration: crit ? 1.2 : 0.9, rise: crit ? 1.4 : 1.0, crit });
  }

  _updateFloatTexts(dt) {
    if (!this._floatTexts.length) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    for (let i = this._floatTexts.length - 1; i >= 0; i--) {
      const ft = this._floatTexts[i];
      ft.age += dt;
      const t = ft.age / ft.duration;
      if (t >= 1) { ft.el.remove(); this._floatTexts.splice(i, 1); continue; }
      TMP_VEC.set(ft.wx, ft.wz + t * ft.rise, ft.wy);
      TMP_VEC.project(this.camera);
      const sx = (TMP_VEC.x * 0.5 + 0.5) * w;
      const sy = (1 - (TMP_VEC.y * 0.5 + 0.5)) * h;
      let transform = `translate(-50%,-50%) translate(${sx}px, ${sy}px)`;
      if (ft.crit && ft.age < CRIT_FLOAT_POP_DURATION) {
        const pop = 1 + CRIT_FLOAT_POP_AMOUNT * (1 - ft.age / CRIT_FLOAT_POP_DURATION);
        transform += ` scale(${pop})`;
      }
      ft.el.style.transform = transform;
      ft.el.style.opacity = String(1 - t * t);
      ft.el.style.display = (TMP_VEC.z > 1 || TMP_VEC.z < -1) ? 'none' : '';
    }
  }

  // ---------------------------------------------------------------- shake / camera / render
  shake(intensity = 1) {
    this._shakeMag = Math.max(this._shakeMag, intensity);
    this._shakeTime = Math.max(this._shakeTime, 0.28 * Math.min(2, intensity + 0.3));
  }

  _updateCamera(game, dt) {
    const p = game.player;
    const px = p ? (this.playerEntry ? this.playerEntry.vx : p.x) : this._camTarget.x;
    const py = p ? (this.playerEntry ? this.playerEntry.vy : p.y) : this._camTarget.z;
    if (!this._camInit) {
      this._camTarget.set(px, 0, py);
      this._camInit = true;
    } else {
      const alpha = 1 - Math.pow(0.0001, dt);
      this._camTarget.x += (px - this._camTarget.x) * alpha;
      this._camTarget.z += (py - this._camTarget.z) * alpha;
    }

    let shakeX = 0, shakeY = 0, shakeZ = 0;
    if (this._shakeTime > 0) {
      this._shakeTime -= dt;
      const mag = this._shakeMag * Math.max(0, this._shakeTime) * 0.15;
      shakeX = (Math.random() * 2 - 1) * mag;
      shakeY = (Math.random() * 2 - 1) * mag * 0.6;
      shakeZ = (Math.random() * 2 - 1) * mag;
      if (this._shakeTime <= 0) this._shakeMag = 0;
    }

    this.camera.position.set(
      this._camTarget.x + shakeX,
      this._camOffsetY + 1.1 + shakeY,
      this._camTarget.z + this._camOffsetZ + shakeZ
    );
    TMP_VEC.set(this._camTarget.x, 0.4, this._camTarget.z);
    this.camera.lookAt(TMP_VEC);

    if (p) this.torchLight.position.set(px, 1.3, py);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
