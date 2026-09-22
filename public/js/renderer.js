// three.js renderer — owned by the Renderer agent. See DESIGN.md §14.
import * as THREE from 'three';
import { TILE, RARITY } from './core.js';
import { getTextures } from './textures.js';

// Entities read small from the angled top-down camera, so scale them up uniformly.
const ENTITY_SCALE = 1.3;

// Bright, cheerful per-depth palettes. `sky` is the background/fog colour that
// unexplored space fades into, so the dungeon reads as a sunny floating maze.
const DEPTH_THEMES = [
  { name: 'meadow', floor: 0x8fd46a, wall: 0xf4e4c1, sky: 0xaee3ff, accent: 0xff4fa0, torch: 0xffd27a },
  { name: 'beach',  floor: 0xf7dc8f, wall: 0xff9f80, sky: 0x9fe9ff, accent: 0x14b8ff, torch: 0xffe08a },
  { name: 'candy',  floor: 0xffc6e0, wall: 0xb9a4ff, sky: 0xfff0fa, accent: 0xff3d8b, torch: 0xffb3e0 },
  { name: 'frost',  floor: 0xd4f1ff, wall: 0x7cc6ff, sky: 0xeaf8ff, accent: 0x2f7bff, torch: 0xbfe9ff },
  { name: 'autumn', floor: 0xffc978, wall: 0xe9806a, sky: 0xffe9c7, accent: 0x9b3dff, torch: 0xffc070 },
];

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
    this.scene.background = new THREE.Color(DEPTH_THEMES[0].sky);

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

    this.scene.fog = new THREE.Fog(DEPTH_THEMES[0].sky, 22, 48);

    this._time = 0;

    this._buildSharedAssets();
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
        for (const mm of mats) if (!mm.userData.shared) mm.dispose();
      }
    });
  }

  // ================================================================== buildMap
  buildMap(map, depth) {
    this._disposeLevel();
    this.map = map;
    this.depth = depth || 1;
    const theme = DEPTH_THEMES[(this.depth - 1) % DEPTH_THEMES.length];
    this._theme = theme;
    this.scene.fog.color.setHex(theme.sky);
    this.scene.background.setHex(theme.sky);
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
    this._skyColor = new THREE.Color(theme.sky);

    for (const f of this._floorTiles) {
      if (f.t === TILE.DOOR) this._buildDoorDecor(map, f.x, f.y);
    }

    if (map.entrance) this._entranceMarker = this._buildEntranceMarker(map.entrance.x, map.entrance.y);
    if (map.exits) for (const e of map.exits) this._exitMarkers.push(this._buildExitMarker(e.x, e.y));

    this._placeTorches(map, wallList);
  }

  _tileMatrix(tile) {
    TMP_MATRIX.makeRotationY(tile.rot || 0);
    TMP_MATRIX.setPosition(tile.x, 0, tile.y);
    return TMP_MATRIX;
  }

  _disposeLevel() {
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

  _buildEntranceMarker(x, y) {
    const root = new THREE.Group();
    root.position.set(x, 0, y);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(this._geo.ring, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ring.scale.set(0.55, 0.55, 1);
    root.add(ring);
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x224433, emissive: 0x55ffcc, emissiveIntensity: 1.2, roughness: 0.4 });
    const core = new THREE.Mesh(this._geo.cylinder, coreMat);
    core.scale.set(0.3, 0.06, 0.3);
    core.position.y = 0.05;
    root.add(core);
    const light = new THREE.PointLight(0x66ffcc, 6, 4, 2);
    light.position.y = 0.6;
    root.add(light);
    this._levelGroup.add(root);
    return { root, ring, light, phase: Math.random() * Math.PI * 2 };
  }

  _buildExitMarker(x, y) {
    const root = new THREE.Group();
    root.position.set(x, 0, y);
    const accent = this._theme.accent;
    const ring1Mat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const ring2Mat = ring1Mat.clone();
    const ring1 = new THREE.Mesh(this._geo.torus, ring1Mat); ring1.rotation.x = Math.PI / 2; ring1.scale.set(0.65, 0.65, 0.65); ring1.position.y = 0.35;
    const ring2 = new THREE.Mesh(this._geo.torus, ring2Mat); ring2.rotation.x = Math.PI / 2; ring2.scale.set(0.45, 0.45, 0.45); ring2.position.y = 0.55;
    root.add(ring1, ring2);
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x111122, emissive: accent, emissiveIntensity: 1.6, roughness: 0.3 });
    const core = new THREE.Mesh(this._geo.sphereLow, coreMat);
    core.scale.setScalar(0.32);
    core.position.y = 0.4;
    root.add(core);
    const light = new THREE.PointLight(accent, 14, 6.5, 2);
    light.position.y = 0.6;
    root.add(light);
    this._levelGroup.add(root);
    return { root, ring1, ring2, core, light, phase: Math.random() * Math.PI * 2 };
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
          if (nt === TILE.FLOOR || nt === TILE.DOOR || nt === TILE.ENTRANCE || nt === TILE.EXIT) { nx = dx; ny = dy; break; }
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
      this._floorMesh.setMatrixAt(f.index, state === FLOOR_STATE.HIDDEN ? TMP_MATRIX.makeScale(0, 0, 0) : this._tileMatrix(f));
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
    if (this._entranceMarker) {
      const m = this._entranceMarker;
      m.ring.rotation.z += dt * 0.6;
      const pulse = 0.9 + 0.3 * Math.sin(this._time * 2 + m.phase);
      m.light.intensity = 6 * pulse;
    }
    for (const m of this._exitMarkers) {
      m.ring1.rotation.z += dt * 1.1;
      m.ring2.rotation.z -= dt * 1.6;
      const pulse = 1.1 + 0.5 * Math.sin(this._time * 3 + m.phase);
      m.light.intensity = 12 * pulse;
      m.core.material.emissiveIntensity = 1.3 * pulse;
      m.core.position.y = 0.4 + Math.sin(this._time * 2 + m.phase) * 0.05;
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
    for (const m of entry.materials) m.opacity = val;
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
  _buildPlayerMesh() {
    const root = new THREE.Group();
    const materials = [];

    const armorMat = this._newMat(0x3d8bff, {}, materials);
    const trimMat = this._newMat(0xd8b34a, { metalness: 0.6, roughness: 0.35 }, materials);
    const skinMat = this._newMat(0xd8a874, { metalness: 0, roughness: 0.8 }, materials);
    const helmMat = this._newMat(0xc7ccd6, { metalness: 0.7, roughness: 0.3 }, materials);
    const capeMat = this._newMat(0x9a2b2b, { side: THREE.DoubleSide, roughness: 0.8 }, materials);
    const bladeMat = this._newMat(0xdfe6ee, { metalness: 0.8, roughness: 0.2 }, materials);
    const hiltMat = this._newMat(0x5a3a20, { roughness: 0.7 }, materials);
    const visorMat = this._newMat(0x2b2d42, { metalness: 0.4, roughness: 0.4 }, materials);

    const legs = new THREE.Mesh(this._geo.box, armorMat);
    legs.scale.set(0.34, 0.32, 0.3); legs.position.y = 0.18; root.add(legs);

    const torso = new THREE.Mesh(this._geo.box, armorMat);
    torso.scale.set(0.42, 0.42, 0.28); torso.position.y = 0.52; root.add(torso);

    const belt = new THREE.Mesh(this._geo.box, trimMat);
    belt.scale.set(0.44, 0.07, 0.3); belt.position.y = 0.34; root.add(belt);

    const shoulderL = new THREE.Mesh(this._geo.sphereLow, trimMat);
    shoulderL.scale.setScalar(0.16); shoulderL.position.set(-0.24, 0.72, 0); root.add(shoulderL);
    const shoulderR = shoulderL.clone(); shoulderR.position.x = 0.24; root.add(shoulderR);

    const head = new THREE.Mesh(this._geo.sphereLow, skinMat);
    head.scale.setScalar(0.19); head.position.y = 0.92; root.add(head);

    const helm = new THREE.Mesh(this._geo.sphereLow, helmMat);
    helm.scale.set(0.21, 0.16, 0.21); helm.position.y = 0.99; root.add(helm);

    const visor = new THREE.Mesh(this._geo.box, visorMat);
    visor.scale.set(0.16, 0.05, 0.04); visor.position.set(0, 0.97, 0.19); root.add(visor);

    const plume = new THREE.Mesh(this._geo.cone, trimMat);
    plume.scale.set(0.06, 0.22, 0.06); plume.position.set(0, 1.18, -0.03); root.add(plume);

    const cape = new THREE.Mesh(this._geo.plane, capeMat);
    cape.scale.set(0.4, 0.5, 1); cape.position.set(0, 0.5, -0.18); cape.rotation.x = 0.2; root.add(cape);

    const armL = new THREE.Mesh(this._geo.box, armorMat);
    armL.scale.set(0.1, 0.32, 0.1); armL.position.set(-0.28, 0.5, 0.02); root.add(armL);

    const swordPivot = new THREE.Group();
    swordPivot.position.set(0.3, 0.55, 0.05);
    const blade = new THREE.Mesh(this._geo.box, bladeMat);
    blade.scale.set(0.05, 0.5, 0.05); blade.position.y = 0.32;
    const hilt = new THREE.Mesh(this._geo.box, hiltMat);
    hilt.scale.set(0.07, 0.12, 0.07); hilt.position.y = 0.02;
    swordPivot.add(blade, hilt);
    root.add(swordPivot);

    root.add(this._makeBlobShadow(0.8));
    root.scale.setScalar(ENTITY_SCALE);
    return { root, materials, sword: swordPivot, cape };
  }

  _updatePlayer(game, dt) {
    const p = game.player;
    if (!p) return;
    if (!this.playerEntry) {
      this.playerEntry = this._buildPlayerMesh();
      this.scene.add(this.playerEntry.root);
      this.playerEntry.vx = p.x; this.playerEntry.vy = p.y;
      this.playerEntry.angle = facingAngle(p.facing?.x || 0, p.facing?.y || 1);
    }
    const entry = this.playerEntry;
    const prevX = entry.vx, prevY = entry.vy;
    this._lerpEntry(entry, p.x, p.y, dt);
    const moving = Math.hypot(entry.vx - prevX, entry.vy - prevY) > 0.001;
    const targetAngle = facingAngle(p.facing?.x || 0, p.facing?.y || 1);
    this._rotateEntryTowards(entry, targetAngle, dt);

    entry.bobPhase = (entry.bobPhase || 0) + dt * (moving ? 9 : 2.2);
    const bob = moving ? Math.sin(entry.bobPhase) * 0.045 : Math.sin(entry.bobPhase) * 0.015;
    entry.root.position.y = bob;

    if (entry.sword) entry.sword.rotation.x = moving ? Math.sin(entry.bobPhase * 2) * 0.15 : 0;
    if (entry.cape) entry.cape.rotation.x = 0.2 + (moving ? Math.sin(entry.bobPhase) * 0.08 : 0);

    this._applyHitFlash(entry, p.hitFlash || 0);
    this._applyInvuln(entry, p.invuln || 0);
  }

  _applyHitFlash(entry, hitFlash) {
    const t = Math.min(1, hitFlash / 0.12);
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
  _buildEnemyVisual(enemy) {
    const shape = (enemy.visual && enemy.visual.shape) || 'blob';
    const colorHex = (enemy.visual && enemy.visual.color) || '#aa4444';
    const scale = ((enemy.visual && enemy.visual.scale) || 1) * ENTITY_SCALE;
    const materials = [];
    const extraMats = [];
    const root = new THREE.Group();
    const color = new THREE.Color(colorHex);
    let anim = {};

    switch (shape) {
      case 'slime': anim = this._partsSlime(root, color, materials); break;
      case 'skeleton': anim = this._partsSkeleton(root, color, materials); break;
      case 'bat': anim = this._partsBat(root, color, materials); break;
      case 'goblin': anim = this._partsGoblin(root, color, materials); break;
      case 'spider': anim = this._partsSpider(root, color, materials); break;
      case 'mage': anim = this._partsMage(root, color, materials); break;
      case 'ogre': anim = this._partsOgre(root, color, materials); break;
      case 'boss': anim = this._partsBoss(root, color, materials, extraMats); break;
      default: anim = this._partsBlob(root, color, materials); break;
    }

    if (shape !== 'bat') root.add(this._makeBlobShadow(shape === 'boss' ? 1.5 : shape === 'ogre' ? 1.1 : 0.8));
    root.scale.setScalar(scale);

    if (enemy.elite) {
      const auraMat = new THREE.MeshBasicMaterial({ color: 0xffd34f, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(this._geo.ring, auraMat);
      ring.rotation.x = -Math.PI / 2;
      ring.scale.set(0.65, 0.65, 1);
      ring.position.y = 0.03;
      root.add(ring);
      anim.aura = ring;
      extraMats.push(auraMat);
    }

    return { root, materials, extraMats, shape, anim, elite: !!enemy.elite, baseScale: scale };
  }

  _partsSlime(root, color, materials) {
    const mat = this._newMat(color, { roughness: 0.3, metalness: 0.05, opacity: 0.88 }, materials);
    const body = new THREE.Mesh(this._geo.sphereLow, mat);
    body.scale.set(0.42, 0.3, 0.42);
    body.position.y = 0.16;
    root.add(body);
    const eyeMat = this._newMat(0x111111, { roughness: 0.9 }, materials);
    const eyeL = new THREE.Mesh(this._geo.sphereLow, eyeMat); eyeL.scale.setScalar(0.05); eyeL.position.set(-0.12, 0.28, 0.32); root.add(eyeL);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.12; root.add(eyeR);
    return { body };
  }

  _partsSkeleton(root, color, materials) {
    const boneMat = this._newMat(color, { roughness: 0.7 }, materials);
    const torso = new THREE.Mesh(this._geo.box, boneMat); torso.scale.set(0.26, 0.4, 0.16); torso.position.y = 0.42; root.add(torso);
    const head = new THREE.Mesh(this._geo.sphereLow, boneMat); head.scale.setScalar(0.15); head.position.y = 0.72; root.add(head);
    const armL = new THREE.Mesh(this._geo.box, boneMat); armL.scale.set(0.07, 0.32, 0.07); armL.position.set(-0.18, 0.42, 0); root.add(armL);
    const armR = armL.clone(); armR.position.x = 0.18; root.add(armR);
    const legL = new THREE.Mesh(this._geo.box, boneMat); legL.scale.set(0.08, 0.34, 0.08); legL.position.set(-0.08, 0.15, 0); root.add(legL);
    const legR = legL.clone(); legR.position.x = 0.08; root.add(legR);
    const weaponMat = this._newMat(0x888888, { metalness: 0.6, roughness: 0.35 }, materials);
    const weapon = new THREE.Mesh(this._geo.box, weaponMat); weapon.scale.set(0.05, 0.42, 0.05); weapon.position.set(0.24, 0.5, 0.05); root.add(weapon);
    return { armL, armR, legL, legR };
  }

  _partsBat(root, color, materials) {
    const mat = this._newMat(color, { roughness: 0.5 }, materials);
    const body = new THREE.Mesh(this._geo.sphereLow, mat); body.scale.set(0.16, 0.14, 0.2); body.position.y = 0.55; root.add(body);
    const wingMat = this._newMat(color.clone().multiplyScalar(0.85), { side: THREE.DoubleSide, roughness: 0.6 }, materials);
    const wingL = new THREE.Mesh(this._geo.plane, wingMat); wingL.scale.set(0.4, 0.22, 1); wingL.position.set(-0.2, 0.55, 0); wingL.rotation.y = Math.PI / 2;
    const wingR = wingL.clone(); wingR.position.x = 0.2;
    root.add(wingL, wingR);
    return { wingL, wingR, body };
  }

  _partsGoblin(root, color, materials) {
    const mat = this._newMat(color, { roughness: 0.65 }, materials);
    const torso = new THREE.Mesh(this._geo.box, mat); torso.scale.set(0.3, 0.34, 0.22); torso.position.y = 0.34; root.add(torso);
    const head = new THREE.Mesh(this._geo.sphereLow, mat); head.scale.setScalar(0.16); head.position.y = 0.6; root.add(head);
    const earL = new THREE.Mesh(this._geo.cone, mat); earL.scale.set(0.05, 0.12, 0.05); earL.position.set(-0.14, 0.63, 0); earL.rotation.z = 0.6; root.add(earL);
    const earR = earL.clone(); earR.position.x = 0.14; earR.rotation.z = -0.6; root.add(earR);
    const weaponMat = this._newMat(0x7a5a3a, { roughness: 0.8 }, materials);
    const weapon = new THREE.Mesh(this._geo.box, weaponMat); weapon.scale.set(0.06, 0.34, 0.06); weapon.position.set(0.2, 0.4, 0.1); weapon.rotation.z = 0.4; root.add(weapon);
    const armL = new THREE.Mesh(this._geo.box, mat); armL.scale.set(0.08, 0.24, 0.08); armL.position.set(-0.16, 0.34, 0); root.add(armL);
    return { armL, weapon };
  }

  _partsSpider(root, color, materials) {
    const mat = this._newMat(color, { roughness: 0.55 }, materials);
    const body = new THREE.Mesh(this._geo.sphereLow, mat); body.scale.set(0.28, 0.2, 0.34); body.position.y = 0.22; root.add(body);
    const abdomen = new THREE.Mesh(this._geo.sphereLow, mat); abdomen.scale.set(0.22, 0.18, 0.24); abdomen.position.set(0, 0.24, -0.26); root.add(abdomen);
    const legs = [];
    for (let i = 0; i < 8; i++) {
      const side = i < 4 ? -1 : 1;
      const idx = i % 4;
      const leg = new THREE.Mesh(this._geo.box, mat);
      leg.scale.set(0.4, 0.045, 0.045);
      leg.position.set(side * 0.28, 0.2, -0.18 + idx * 0.13);
      leg.rotation.y = side * 0.5 + (idx - 1.5) * 0.15;
      root.add(leg);
      legs.push({ mesh: leg, phase: i * 0.7, baseY: leg.position.y });
    }
    const eyeMat = this._newMat(0xff2222, { emissive: 0x660000, emissiveIntensity: 0.8 }, materials);
    for (const dx of [-0.06, 0.06]) {
      const eye = new THREE.Mesh(this._geo.sphereLow, eyeMat); eye.scale.setScalar(0.035); eye.position.set(dx, 0.3, 0.36); root.add(eye);
    }
    return { legs };
  }

  _partsMage(root, color, materials) {
    const robeMat = this._newMat(color, { roughness: 0.75 }, materials);
    const robe = new THREE.Mesh(this._geo.cone, robeMat); robe.scale.set(0.34, 0.55, 0.34); robe.position.y = 0.3; root.add(robe);
    const headMat = this._newMat(0xd8b98a, { roughness: 0.8 }, materials);
    const head = new THREE.Mesh(this._geo.sphereLow, headMat); head.scale.setScalar(0.14); head.position.y = 0.68; root.add(head);
    const hood = new THREE.Mesh(this._geo.sphereLow, robeMat); hood.scale.set(0.17, 0.14, 0.17); hood.position.y = 0.74; root.add(hood);
    const staffMat = this._newMat(0x5a4530, { roughness: 0.7 }, materials);
    const staff = new THREE.Mesh(this._geo.cylinder, staffMat); staff.scale.set(0.03, 0.6, 0.03); staff.position.set(0.22, 0.4, 0); root.add(staff);
    const orbMat = this._newMat(0x66aaff, { emissive: 0x3388ff, emissiveIntensity: 1.2 }, materials);
    const orb = new THREE.Mesh(this._geo.sphereLow, orbMat); orb.scale.setScalar(0.08); orb.position.set(0.22, 0.72, 0); root.add(orb);
    return { orb, staff };
  }

  _partsOgre(root, color, materials) {
    const mat = this._newMat(color, { roughness: 0.7 }, materials);
    const torso = new THREE.Mesh(this._geo.box, mat); torso.scale.set(0.6, 0.56, 0.4); torso.position.y = 0.5; root.add(torso);
    const head = new THREE.Mesh(this._geo.sphereLow, mat); head.scale.setScalar(0.22); head.position.y = 0.94; root.add(head);
    const armL = new THREE.Mesh(this._geo.box, mat); armL.scale.set(0.16, 0.44, 0.16); armL.position.set(-0.4, 0.5, 0); root.add(armL);
    const armR = armL.clone(); armR.position.x = 0.4; root.add(armR);
    const clubMat = this._newMat(0x6b5738, { roughness: 0.85 }, materials);
    const club = new THREE.Mesh(this._geo.cylinder, clubMat); club.scale.set(0.12, 0.5, 0.12); club.position.set(0.5, 0.32, 0.1); club.rotation.z = 0.3; root.add(club);
    return { armL, armR };
  }

  _partsBoss(root, color, materials, extraMats) {
    const mat = this._newMat(color, { roughness: 0.6, metalness: 0.2 }, materials);
    const torso = new THREE.Mesh(this._geo.box, mat); torso.scale.set(0.8, 0.8, 0.56); torso.position.y = 0.7; root.add(torso);
    const head = new THREE.Mesh(this._geo.sphereLow, mat); head.scale.setScalar(0.3); head.position.y = 1.35; root.add(head);
    const hornMat = this._newMat(0xffffff, { roughness: 0.3, metalness: 0.4 }, materials);
    for (const s of [-1, 1]) {
      const horn = new THREE.Mesh(this._geo.cone, hornMat); horn.scale.set(0.06, 0.22, 0.06); horn.position.set(s * 0.14, 1.55, 0); horn.rotation.z = s * 0.3; root.add(horn);
    }
    const eyeMat = this._newMat(0xff3300, { emissive: 0xff3300, emissiveIntensity: 1.5 }, materials);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(this._geo.sphereLow, eyeMat); eye.scale.setScalar(0.045); eye.position.set(s * 0.1, 1.38, 0.28); root.add(eye);
    }
    const armL = new THREE.Mesh(this._geo.box, mat); armL.scale.set(0.22, 0.6, 0.22); armL.position.set(-0.55, 0.7, 0); root.add(armL);
    const armR = armL.clone(); armR.position.x = 0.55; root.add(armR);
    const auraMat = new THREE.MeshBasicMaterial({ color: color.getHex(), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const aura = new THREE.Mesh(this._geo.ring, auraMat);
    aura.rotation.x = -Math.PI / 2; aura.scale.set(0.95, 0.95, 1); aura.position.y = 0.04;
    root.add(aura);
    extraMats.push(auraMat);
    return { armL, armR, aura, eyeMat };
  }

  _partsBlob(root, color, materials) {
    const mat = this._newMat(color, { roughness: 0.6 }, materials);
    const body = new THREE.Mesh(this._geo.sphereLow, mat); body.scale.set(0.3, 0.3, 0.3); body.position.y = 0.3; root.add(body);
    return {};
  }

  _animateEnemyEntry(entry, enemy, dt, moving) {
    entry.bobPhase = (entry.bobPhase !== undefined ? entry.bobPhase : Math.random() * 10) + dt * (moving ? 8 : 2.5);
    const t = this._time;
    switch (entry.shape) {
      case 'slime': {
        const squish = 1 + Math.sin(entry.bobPhase * 1.6) * 0.18;
        if (entry.anim.body) entry.anim.body.scale.set(0.42 * (2 - squish), 0.3 * squish, 0.42 * (2 - squish));
        break;
      }
      case 'bat': {
        const flap = Math.sin(t * 14 + entry.bobPhase);
        if (entry.anim.wingL) entry.anim.wingL.rotation.z = flap * 0.9;
        if (entry.anim.wingR) entry.anim.wingR.rotation.z = -flap * 0.9;
        entry.root.position.y = 0.3 + Math.sin(t * 3 + entry.bobPhase) * 0.08;
        break;
      }
      case 'spider': {
        for (const leg of entry.anim.legs || []) {
          leg.mesh.position.y = leg.baseY + Math.sin(t * 10 + leg.phase) * (moving ? 0.04 : 0.015);
        }
        break;
      }
      case 'skeleton': {
        const swing = moving ? Math.sin(entry.bobPhase * 1.8) * 0.5 : 0;
        if (entry.anim.armL) entry.anim.armL.rotation.x = swing;
        if (entry.anim.armR) entry.anim.armR.rotation.x = -swing;
        if (entry.anim.legL) entry.anim.legL.rotation.x = -swing;
        if (entry.anim.legR) entry.anim.legR.rotation.x = swing;
        entry.root.position.y = moving ? Math.abs(Math.sin(entry.bobPhase)) * 0.04 : 0;
        break;
      }
      case 'goblin': {
        const swing = moving ? Math.sin(entry.bobPhase * 2) * 0.4 : 0;
        if (entry.anim.armL) entry.anim.armL.rotation.x = swing;
        entry.root.position.y = moving ? Math.abs(Math.sin(entry.bobPhase)) * 0.05 : 0;
        break;
      }
      case 'mage': {
        if (entry.anim.orb) entry.anim.orb.material.emissiveIntensity = 1.0 + 0.5 * Math.sin(t * 4);
        entry.root.position.y = Math.sin(entry.bobPhase * 0.8) * 0.03;
        break;
      }
      case 'ogre': {
        const swing = moving ? Math.sin(entry.bobPhase * 1.4) * 0.35 : Math.sin(t * 1.5) * 0.05;
        if (entry.anim.armL) entry.anim.armL.rotation.x = swing;
        if (entry.anim.armR) entry.anim.armR.rotation.x = -swing;
        entry.root.position.y = moving ? Math.abs(Math.sin(entry.bobPhase * 0.7)) * 0.05 : 0;
        break;
      }
      case 'boss': {
        const swing = moving ? Math.sin(entry.bobPhase * 1.1) * 0.3 : Math.sin(t * 1.2) * 0.06;
        if (entry.anim.armL) entry.anim.armL.rotation.x = swing;
        if (entry.anim.armR) entry.anim.armR.rotation.x = -swing;
        if (entry.anim.eyeMat) entry.anim.eyeMat.emissiveIntensity = 1.2 + 0.6 * Math.sin(t * 5);
        entry.root.position.y = moving ? Math.abs(Math.sin(entry.bobPhase * 0.6)) * 0.06 : 0;
        break;
      }
      default:
        entry.root.position.y = Math.sin(entry.bobPhase * 0.8) * 0.02;
    }
    if (entry.anim.aura) entry.anim.aura.rotation.z += dt * (entry.shape === 'boss' ? 0.5 : 0.9);
  }

  _applyStatusEffects(entry, enemy) {
    const frozen = enemy.frozen > 0, slow = !frozen && enemy.slow > 0;
    const flashAmt = Math.min(1, (enemy.hitFlash || 0) / 0.12);
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

  _animateEnemyDeath(entry, enemy) {
    if (entry.deathStart === undefined) entry.deathStart = Math.max(enemy.deathTimer || 0.4, 0.0001);
    const t = 1 - THREE.MathUtils.clamp((enemy.deathTimer || 0) / entry.deathStart, 0, 1);
    entry.root.scale.setScalar(Math.max(0.001, (1 - t)) * (entry.baseScale || 1));
    entry.root.position.y = -t * 0.6;
    for (const m of entry.materials) m.opacity = Math.max(0, 1 - t);
    for (const m of entry.extraMats) m.opacity = Math.max(0, (m.userData?.baseOpacity ?? m.opacity) * (1 - t));
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
    const heightAdd = (entry.elite ? 0.3 : 0) + (entry.shape === 'boss' ? 0.55 : 0);
    entry.hpBarGroup.scale.setScalar(scaleUp);
    entry.hpBarGroup.position.set(entry.vx, 1.05 * (entry.baseScale || 1) + heightAdd, entry.vy);
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
      if (entry.hpBarGroup) entry.hpBarGroup.visible = visible && !enemy.dead && enemy.hp < enemy.maxHp;
      if (!visible) continue;

      if (enemy.dead) {
        this._animateEnemyDeath(entry, enemy);
        continue;
      }

      const prevX = entry.vx, prevY = entry.vy;
      this._lerpEntry(entry, enemy.x, enemy.y, dt, 16);
      const moved = Math.hypot(entry.vx - prevX, entry.vy - prevY) > 0.001;
      const targetAngle = facingAngle(enemy.facing?.x || 0, enemy.facing?.y || 1);
      this._rotateEntryTowards(entry, targetAngle, dt);
      this._applyStatusEffects(entry, enemy);
      this._animateEnemyEntry(entry, enemy, dt, moved);
      this._updateHealthBar(entry, enemy);
    }
    for (const [id, entry] of this.enemyEntries) {
      if (!seen.has(id)) { this._removeEntry(entry); this.enemyEntries.delete(id); }
    }
  }

  // ---------------------------------------------------------------- ground items
  _buildItemVisual(item) {
    const root = new THREE.Group();
    const materials = [];
    let beamMat = null;
    if (!item || item.type === 'gold') {
      const mat = this._newMat(0xffd24a, { emissive: 0x553800, emissiveIntensity: 0.6, metalness: 0.7, roughness: 0.3 }, materials);
      for (let i = 0; i < 3; i++) {
        const coin = new THREE.Mesh(this._geo.cylinder, mat);
        coin.scale.set(0.16, 0.04, 0.16);
        coin.position.set((i - 1) * 0.05, 0.02 + i * 0.03, (i % 2) * 0.04);
        root.add(coin);
      }
    } else if (item.type === 'potion') {
      const isMana = item.potion && item.potion.mana > 0 && !(item.potion.heal > 0);
      const liquidColor = isMana ? 0x3aa0ff : 0xe23a3a;
      const glassMat = this._newMat(0xbfe8ff, { transparent: true, opacity: 0.55, roughness: 0.2, metalness: 0.1 }, materials);
      const liquidMat = this._newMat(liquidColor, { emissive: liquidColor, emissiveIntensity: 0.5 }, materials);
      const body = new THREE.Mesh(this._geo.sphereLow, liquidMat); body.scale.set(0.14, 0.16, 0.14); body.position.y = 0.14; root.add(body);
      const neck = new THREE.Mesh(this._geo.cylinder, glassMat); neck.scale.set(0.06, 0.1, 0.06); neck.position.y = 0.28; root.add(neck);
      const cork = new THREE.Mesh(this._geo.cylinder, this._newMat(0x8a6a3a, { roughness: 0.9 }, materials));
      cork.scale.set(0.055, 0.04, 0.055); cork.position.y = 0.35; root.add(cork);
    } else {
      const rarity = RARITY[item.rarity] || RARITY.common;
      const color = new THREE.Color(rarity.color);
      const mat = this._newMat(color, { emissive: color.clone().multiplyScalar(0.4), emissiveIntensity: 0.8, metalness: 0.4, roughness: 0.35 }, materials);
      const gem = new THREE.Mesh(this._geo.sphereLow, mat);
      gem.scale.set(0.16, 0.2, 0.16);
      gem.position.y = 0.22;
      root.add(gem);
      if (item.rarity === 'epic' || item.rarity === 'legendary') {
        const bMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
        const beam = new THREE.Mesh(this._geo.cylinder, bMat);
        beam.scale.set(0.12, 1.6, 0.12);
        beam.position.y = 0.9;
        root.add(beam);
        beamMat = bMat;
        materials.push(bMat);
      }
    }
    return { root, materials, beamMat, phase: Math.random() * 10 };
  }

  _syncItems(game, dt) {
    const list = game.groundItems || [];
    const seen = new Set();
    const map = game.map;
    for (const gi of list) {
      seen.add(gi.id);
      let entry = this.itemEntries.get(gi.id);
      if (!entry) {
        entry = this._buildItemVisual(gi.item);
        this.scene.add(entry.root);
        this.itemEntries.set(gi.id, entry);
      }
      entry.root.position.x = gi.x;
      entry.root.position.z = gi.y;
      const visible = this._tileVisible(map, gi.x, gi.y);
      entry.root.visible = visible;
      if (!visible) continue;
      entry.phase += dt;
      entry.root.rotation.y += dt * 1.4;
      entry.root.position.y = 0.28 + Math.sin(entry.phase * 2) * 0.06;
      if (entry.beamMat) entry.beamMat.opacity = 0.3 + 0.15 * Math.sin(entry.phase * 3);
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
      case 'slash': this._fxSlash(x, y, opts); break;
      case 'nova': this._fxNova(x, y, opts); break;
      case 'dash': this._fxDash(x, y, opts); break;
      case 'hit': this._fxBurst(x, y, { color: opts.color || '#ffdd88', count: 10, speed: 2.5, size: 0.09, duration: 0.35, gravity: 0 }); break;
      case 'death': this._fxBurst(x, y, { color: opts.color || '#ff5555', count: 18, speed: 3.2, size: 0.12, duration: 0.6, gravity: 3 }); break;
      case 'levelup': this._fxLevelup(x, y, opts); break;
      case 'heal': this._fxBurst(x, y, { color: opts.color || '#55ff88', count: 14, speed: 1.0, size: 0.09, duration: 0.9, gravity: -1.0 }); break;
      case 'pickup': this._fxBurst(x, y, { color: opts.color || '#ffffff', count: 6, speed: 1.0, size: 0.06, duration: 0.35, gravity: -0.5 }); break;
      case 'exit': this._fxNova(x, y, { radius: opts.radius || 3, color: this._theme ? this._theme.accent : 0x8fe0ff }); this.shake(0.15); break;
      default: break;
    }
  }

  _fxSlash(x, y, opts) {
    const dir = opts.dir || { x: 0, y: 1 };
    const angle = facingAngle(dir.x, dir.y);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(this._geo.arc, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -angle - Math.PI / 2;
    mesh.position.set(x + dir.x * 0.35, 0.2, y + dir.y * 0.35);
    mesh.scale.set(0.6, 0.6, 1);
    this.scene.add(mesh);
    this.effects.push({
      obj: mesh, mats: [mat], age: 0, duration: 0.22, update: (t) => {
        const s = 0.6 + 0.5 * t;
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
    el.style.cssText = `position:absolute;left:0;top:0;transform:translate(-50%,-50%);font-family:Arial,Helvetica,sans-serif;font-weight:800;white-space:nowrap;pointer-events:none;color:${color || '#ffffff'};text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 2px 4px rgba(0,0,0,0.7);font-size:${size}px;`;
    this.overlay.appendChild(el);
    this._floatTexts.push({ el, wx: x, wy: y, wz: 0.9, age: 0, duration: crit ? 1.2 : 0.9, rise: crit ? 1.4 : 1.0 });
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
      ft.el.style.transform = `translate(-50%,-50%) translate(${sx}px, ${sy}px)`;
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
