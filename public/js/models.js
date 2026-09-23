// Procedural character models (player hero, every enemy shape, both bosses, the merchant) and
// their idle/walk animations. Owned by the Renderer (renderer.js constructs `new Models(this)`).
//
// Performance notes:
// - Static clusters of parts that share a material are *baked* into one vertex-coloured
//   BufferGeometry (cached per model/colour key, shared by every instance, never disposed),
//   so an enemy is ~6-14 draw calls instead of 20-40.
// - Materials are always per instance (the hit flash / freeze tint are per enemy) and are
//   pushed onto the entry's `materials` (MeshStandardMaterial only) or `extraMats` (sprites /
//   basic materials) lists, which renderer._removeEntry disposes.
// - No real lights: glows are emissive materials plus additive sprites.
import * as THREE from 'three';
import { RARITY } from './core.js';

const WHITE = new THREE.Color(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

const col = (c) => (c instanceof THREE.Color ? c.clone() : new THREE.Color(c));
const lighten = (c, t) => col(c).lerp(WHITE, t);
const darken = (c, f) => col(c).multiplyScalar(f);
const mix = (a, b, t) => col(a).lerp(col(b), t);
const lerp = THREE.MathUtils.lerp;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (t) => 1 - (1 - t) * (1 - t);

// Part spec: [geometryName, colour, scale (number | [x,y,z]), position [x,y,z], rotation ([x,y,z] Euler | Quaternion)]
function P(g, c, s, p, r) { return [g, c, s, p, r]; }
// A cylinder-ish part spanning point a -> b.
function seg(g, c, a, b, rad) {
  const va = new THREE.Vector3(a[0], a[1], a[2]), vb = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  const sy = g === 'capsule' ? len / 2 : len;
  return [g, c, [rad * 2, sy, rad * 2], va.add(vb).multiplyScalar(0.5).toArray(), q];
}
function mirrorX(parts) {
  return parts.map(([g, c, s, p, r]) => {
    const pp = p ? [-p[0], p[1], p[2]] : p;
    let rr = r;
    if (Array.isArray(r)) rr = [r[0], -r[1], -r[2]];
    else if (r && r.isQuaternion) rr = new THREE.Quaternion(r.x, -r.y, -r.z, r.w);
    return [g, c, s, pp, rr];
  });
}

export const SWING_DURATION = 0.26;

export class Models {
  constructor(renderer) {
    this.r = renderer;
    this.geo = renderer._geo;
    this._bakeCache = new Map();
    this._initGeo();
  }

  _initGeo() {
    const g = this.geo;
    g.sphere = new THREE.SphereGeometry(0.5, 12, 8);
    g.sphereHi = new THREE.SphereGeometry(0.5, 18, 12);
    g.dome = new THREE.SphereGeometry(0.5, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    g.capsule = new THREE.CapsuleGeometry(0.5, 1, 2, 8);
    g.cyl6 = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
    g.frustum = new THREE.CylinderGeometry(0.4, 0.5, 1, 10);
    g.robe = new THREE.CylinderGeometry(0.18, 0.5, 1, 10);
    g.band = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, true);
    g.octa = new THREE.OctahedronGeometry(0.5);
    g.bowThin = new THREE.TorusGeometry(0.5, 0.045, 5, 14, Math.PI);
    g.cone6 = new THREE.ConeGeometry(0.5, 1, 6);
    g.rib = new THREE.TorusGeometry(0.5, 0.09, 4, 10, Math.PI * 1.3);
    // Rib arcs lie flat (XZ) with the gap at the back (-z) where the spine is.
    g.rib.rotateZ(-Math.PI / 2 - 0.65 * Math.PI); // arc midpoint -> -y
    g.rib.rotateX(-Math.PI / 2);                  // lay flat: midpoint -> +z (front), gap at the back

    // Cape: hangs down from y=0, flares and curls back toward the hem.
    const cape = new THREE.PlaneGeometry(1, 1, 2, 4);
    cape.translate(0, -0.5, 0);
    const cp = cape.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const t = -cp.getY(i);
      cp.setX(i, cp.getX(i) * (1 + 0.45 * t));
      cp.setZ(i, -0.22 * t * t - 0.05 * Math.abs(cp.getX(i)) * 2);
    }
    cape.computeVertexNormals();
    g.cape = cape;

    // Tattered cape for the Bone Tyrant: jagged hem.
    const tat = new THREE.PlaneGeometry(1, 1, 6, 3);
    tat.translate(0, -0.5, 0);
    const tp = tat.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const t = -tp.getY(i);
      const x = tp.getX(i);
      let y = tp.getY(i);
      if (t > 0.99) y += ((Math.round((x + 0.5) * 6) % 2) ? 0.22 : 0);
      tp.setY(i, y);
      tp.setX(i, x * (1 + 0.35 * t));
      tp.setZ(i, -0.18 * t * t);
    }
    tat.computeVertexNormals();
    g.tatteredCape = tat;

    // Bat wing membrane with a scalloped trailing edge, lying flat, extending along +x.
    const s = new THREE.Shape();
    const pts = [[0, 0.08], [0.28, 0.17], [0.58, 0.05], [0.48, -0.05], [0.41, -0.01], [0.35, -0.14], [0.26, -0.07], [0.17, -0.17], [0.09, -0.07], [0, -0.09]];
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.closePath();
    g.wing = new THREE.ShapeGeometry(s);
    g.wing.rotateX(Math.PI / 2); // lay flat; leading edge (+y in the shape) ends up at +z (forward)
  }

  // ---------------------------------------------------------------- helpers
  bake(name, parts) {
    const key = name + '|' + parts.map((p) => col(p[1]).getHexString()).join(',');
    let geo = this._bakeCache.get(key);
    if (geo) return geo;
    let total = 0;
    const pieces = [];
    for (const [gname, c, sc, pos, rot] of parts) {
      const src = this.geo[gname];
      if (!src) throw new Error('models.js: unknown geometry ' + gname);
      const g = src.index ? src.toNonIndexed() : src.clone();
      const s3 = typeof sc === 'number' ? [sc, sc, sc] : (sc || [1, 1, 1]);
      if (rot && rot.isQuaternion) _q.copy(rot);
      else _q.setFromEuler(_e.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0));
      _m.compose(_p.set(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0), _q, _s.set(s3[0], s3[1], s3[2]));
      g.applyMatrix4(_m);
      pieces.push({ g, c: col(c) });
      total += g.attributes.position.count;
    }
    const posArr = new Float32Array(total * 3), norArr = new Float32Array(total * 3), colArr = new Float32Array(total * 3);
    let o = 0;
    for (const { g, c } of pieces) {
      const pa = g.attributes.position.array, na = g.attributes.normal.array;
      posArr.set(pa, o * 3); norArr.set(na, o * 3);
      const n = g.attributes.position.count;
      for (let i = 0; i < n; i++) { colArr[(o + i) * 3] = c.r; colArr[(o + i) * 3 + 1] = c.g; colArr[(o + i) * 3 + 2] = c.b; }
      o += n;
      g.dispose();
    }
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(norArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    geo.computeBoundingSphere();
    geo.userData.shared = true;
    this._bakeCache.set(key, geo);
    return geo;
  }

  mesh(name, parts, mat, parent, pos) {
    const m = new THREE.Mesh(this.bake(name, parts), mat);
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    parent.add(m);
    return m;
  }

  single(gname, mat, parent, s, p, r) {
    const m = new THREE.Mesh(this.geo[gname], mat);
    const s3 = typeof s === 'number' ? [s, s, s] : s;
    m.scale.set(s3[0], s3[1], s3[2]);
    if (p) m.position.set(p[0], p[1], p[2]);
    if (r) m.rotation.set(r[0], r[1], r[2]);
    parent.add(m);
    return m;
  }

  pivot(parent, x, y, z, order) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    if (order) g.rotation.order = order;
    parent.add(g);
    return g;
  }

  mat(color, extra, list) { return this.r._newMat(color, extra, list); }
  vmat(list, extra) {
    return this.r._newMat(0xffffff, Object.assign({ vertexColors: true, roughness: 0.7, metalness: 0.05 }, extra || {}), list);
  }
  glow(color, size, opacity, list, parent, pos) {
    const m = new THREE.SpriteMaterial({ map: this.r._tex.glow, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    m.userData.baseOpacity = opacity;
    list.push(m);
    const sp = new THREE.Sprite(m);
    sp.scale.setScalar(size);
    if (pos) sp.position.set(pos[0], pos[1], pos[2]);
    parent.add(sp);
    return sp;
  }

  // ================================================================== PLAYER
  buildPlayer() {
    const root = new THREE.Group();
    const materials = [];
    const cloth = this.vmat(materials, { roughness: 0.75 });
    const metal = this.vmat(materials, { roughness: 0.32, metalness: 0.55 });
    const capeMat = this.mat(0xd8413c, { side: THREE.DoubleSide, roughness: 0.8 }, materials);

    const TUNIC = 0x3d86ff, TUNIC_D = 0x2a5fc8, CREAM = 0xf4ead0, GOLD = 0xf0c040, BELT = 0x6b4423,
      SKIN = 0xf3c49c, BOOT = 0x6a4428, BOOT_D = 0x4a2e1a, PANTS = 0x3a3552, STEEL = 0xd6dde8, STEEL_D = 0x9aa4b4,
      PLUME = 0xff4a4a, EYE = 0x2b2233, BLUSH = 0xff9a9a;

    // Legs (pivot at the hip).
    const legParts = [
      P('capsule', PANTS, [0.13, 0.1, 0.13], [0, -0.1, 0]),
      P('cylinder', BOOT_D, [0.15, 0.05, 0.15], [0, -0.2, 0]),
      P('sphere', BOOT, [0.16, 0.13, 0.23], [0, -0.28, 0.035]),
    ];
    const legL = this.pivot(root, 0.1, 0.35, 0);
    const legR = this.pivot(root, -0.1, 0.35, 0);
    this.mesh('pl_leg', legParts, cloth, legL);
    this.mesh('pl_leg', legParts, cloth, legR);

    // Upper body (twists with the swing / stride).
    const body = this.pivot(root, 0, 0, 0);
    this.mesh('pl_torso', [
      P('frustum', TUNIC_D, [0.46, 0.17, 0.38], [0, 0.4, 0]),
      P('sphere', TUNIC, [0.42, 0.4, 0.32], [0, 0.57, 0]),
      P('box', CREAM, [0.2, 0.36, 0.05], [0, 0.49, 0.145]),
      P('octa', GOLD, [0.09, 0.11, 0.04], [0, 0.57, 0.175]),
      P('cylinder', BELT, [0.41, 0.06, 0.34], [0, 0.4, 0]),
      P('box', GOLD, [0.08, 0.065, 0.04], [0, 0.4, 0.17]),
      P('cylinder', SKIN, [0.11, 0.08, 0.11], [0, 0.77, 0]),
    ], cloth, body);
    this.mesh('pl_pauldrons', [
      P('dome', STEEL, [0.22, 0.2, 0.22], [0.215, 0.69, 0]),
      P('dome', STEEL, [0.22, 0.2, 0.22], [-0.215, 0.69, 0]),
      P('cylinder', GOLD, [0.225, 0.03, 0.225], [0.215, 0.69, 0]),
      P('cylinder', GOLD, [0.225, 0.03, 0.225], [-0.215, 0.69, 0]),
    ], metal, body);

    // Head with an open-faced helmet and a red crest (reads well from above).
    const head = this.pivot(body, 0, 0.94, 0);
    this.mesh('pl_head', [
      P('sphere', SKIN, [0.38, 0.36, 0.36], [0, 0, 0]),
      P('sphereLow', EYE, [0.055, 0.08, 0.03], [0.07, 0.0, 0.17]),
      P('sphereLow', EYE, [0.055, 0.08, 0.03], [-0.07, 0.0, 0.17]),
      P('sphereLow', BLUSH, [0.05, 0.028, 0.02], [0.115, -0.06, 0.155]),
      P('sphereLow', BLUSH, [0.05, 0.028, 0.02], [-0.115, -0.06, 0.155]),
      P('sphere', PLUME, [0.08, 0.14, 0.36], [0, 0.27, -0.04]),
    ], cloth, head);
    this.mesh('pl_helm', [
      P('dome', STEEL, [0.42, 0.36, 0.42], [0, 0.06, -0.01]),
      P('cylinder', STEEL_D, [0.43, 0.045, 0.43], [0, 0.07, -0.01]),
      P('box', STEEL_D, [0.035, 0.08, 0.03], [0, 0.04, 0.2]),
      P('cylinder', GOLD, [0.06, 0.06, 0.06], [0, 0.24, 0.01]),
    ], metal, head);

    // Arms (pivot at the shoulder). Character's right hand (-x) holds the weapon.
    const armParts = [
      P('capsule', TUNIC, [0.11, 0.085, 0.11], [0, -0.1, 0]),
      P('cylinder', GOLD, [0.12, 0.04, 0.12], [0, -0.18, 0]),
      P('sphere', BELT, [0.12, 0.12, 0.12], [0, -0.24, 0]),
    ];
    const armR = this.pivot(body, -0.25, 0.68, 0, 'YXZ');
    const armL = this.pivot(body, 0.25, 0.68, 0, 'YXZ');
    this.mesh('pl_arm', armParts, cloth, armR);
    this.mesh('pl_arm', armParts, cloth, armL);
    const weaponMount = this.pivot(armR, 0, -0.25, 0.01);
    const offMount = this.pivot(armL, 0, -0.25, 0.01);

    // Cape.
    const cape = new THREE.Mesh(this.geo.cape, capeMat);
    cape.scale.set(0.36, 0.56, 1);
    cape.position.set(0, 0.74, -0.14);
    body.add(cape);

    root.add(this.r._makeBlobShadow(0.8));
    return {
      root, materials, cape, sword: weaponMount,
      anim: { body, head, legL, legR, armL, armR, weaponMount, offMount },
    };
  }

  // Held weapon / off-hand, grip at the origin, business end along +y. Returns { group, mats }.
  buildHeld(kind, rarity, slot) {
    const mats = [];
    const g = new THREE.Group();
    const accentHex = (RARITY[rarity] || RARITY.common).color;
    const metal = this.vmat(mats, { roughness: 0.3, metalness: 0.3, emissive: 0x3a4250, emissiveIntensity: 0.35 });
    const wood = this.vmat(mats, { roughness: 0.8 });
    const accent = this.mat(accentHex, { emissive: accentHex, emissiveIntensity: rarity && rarity !== 'common' ? 0.7 : 0.25, roughness: 0.3, metalness: 0.2 }, mats);
    const STEEL = 0xcbd6e8, DARK = 0x585e70, GOLD = 0xf0c040, WOOD = 0x8a5a34, LEATHER = 0x6b4423, W = 0xffffff;
    let spec;
    switch (kind) {
      case 'dagger':
        spec = {
          metal: [P('box', STEEL, [0.06, 0.22, 0.02], [0, 0.2, 0]), P('cone', STEEL, [0.06, 0.07, 0.02], [0, 0.345, 0]), P('box', GOLD, [0.15, 0.04, 0.05], [0, 0.08, 0])],
          wood: [P('cylinder', LEATHER, [0.045, 0.1, 0.045], [0, 0.02, 0])],
          accent: [P('sphereLow', W, 0.055, [0, -0.045, 0])],
        };
        break;
      case 'axe':
        spec = {
          metal: [P('box', STEEL, [0.16, 0.15, 0.03], [0.09, 0.4, 0]), P('cylinder', STEEL, [0.24, 0.03, 0.24], [0.17, 0.4, 0], [Math.PI / 2, 0, 0])],
          wood: [P('cylinder', WOOD, [0.045, 0.6, 0.045], [0, 0.17, 0])],
          accent: [P('sphereLow', W, 0.06, [0, 0.48, 0])],
        };
        break;
      case 'mace': {
        const m = [P('sphere', DARK, 0.17, [0, 0.42, 0]), P('cone', STEEL, [0.06, 0.1, 0.06], [0, 0.54, 0])];
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          m.push(P('cone', STEEL, [0.06, 0.1, 0.06], [Math.cos(a) * 0.1, 0.42, Math.sin(a) * 0.1], [0, -a, -Math.PI / 2]));
        }
        spec = { metal: m, wood: [P('cylinder', WOOD, [0.045, 0.44, 0.045], [0, 0.13, 0])], accent: [P('torus', W, [0.1, 0.1, 0.2], [0, 0.3, 0], [Math.PI / 2, 0, 0])] };
        break;
      }
      case 'staff':
        spec = {
          metal: [P('torus', GOLD, [0.22, 0.22, 0.3], [0, 0.68, 0])],
          wood: [P('cylinder', WOOD, [0.04, 1.0, 0.04], [0, 0.15, 0]), P('cone', WOOD, [0.06, 0.12, 0.06], [0, 0.6, 0], [Math.PI, 0, 0])],
          accent: [P('sphere', W, 0.14, [0, 0.72, 0])],
        };
        break;
      case 'bow':
        spec = {
          metal: [P('box', 0xf4f1e6, [0.012, 0.56, 0.012], [0, 0, -0.01])],
          wood: [P('bowThin', WOOD, 0.58, [0, 0, 0], [0, -Math.PI / 2, -Math.PI / 2])],
          accent: [P('box', W, [0.05, 0.1, 0.05], [0, 0, 0.29])],
        };
        break;
      case 'shield':
        spec = {
          metal: [P('torus', STEEL, [0.36, 0.36, 0.5]), P('sphereLow', STEEL, [0.08, 0.08, 0.05], [0, 0, 0.03])],
          wood: [P('cylinder', WOOD, [0.36, 0.05, 0.36], [0, 0, 0], [Math.PI / 2, 0, 0])],
          accent: [P('box', W, [0.06, 0.3, 0.02], [0, 0, 0.03]), P('box', W, [0.3, 0.06, 0.02], [0, 0, 0.03])],
        };
        break;
      case 'orb':
        spec = {
          metal: [P('cylinder', GOLD, [0.11, 0.04, 0.11], [0, 0.03, 0.03]), P('torus', GOLD, [0.2, 0.2, 0.3], [0, 0.1, 0.03], [Math.PI / 2, 0, 0])],
          wood: [],
          accent: [P('sphere', W, 0.15, [0, 0.12, 0.03])],
        };
        break;
      case 'tome':
        spec = {
          metal: [P('box', GOLD, [0.03, 0.2, 0.06], [-0.075, 0.08, 0])],
          wood: [P('box', 0x7a2a3a, [0.17, 0.21, 0.05], [0, 0.08, 0]), P('box', 0xfaf3dd, [0.15, 0.19, 0.056], [0.012, 0.08, 0])],
          accent: [P('octa', W, [0.06, 0.07, 0.03], [0, 0.08, 0.03])],
        };
        break;
      case 'sword':
      default:
        spec = {
          metal: [P('box', STEEL, [0.065, 0.4, 0.022], [0, 0.3, 0]), P('cone', STEEL, [0.065, 0.08, 0.022], [0, 0.54, 0]), P('box', GOLD, [0.2, 0.045, 0.06], [0, 0.09, 0])],
          wood: [P('cylinder', LEATHER, [0.045, 0.12, 0.045], [0, 0.02, 0])],
          accent: [P('sphereLow', W, 0.06, [0, -0.05, 0])],
        };
    }
    const k = 'held_' + (kind || 'sword');
    if (spec.metal.length) this.mesh(k + '_m', spec.metal, metal, g);
    if (spec.wood.length) this.mesh(k + '_w', spec.wood, wood, g);
    if (spec.accent.length) this.mesh(k + '_a', spec.accent, accent, g);
    // Keep only materials actually used.
    const used = new Set(); g.traverse((o) => { if (o.material) used.add(o.material); });
    for (const m of mats) if (!used.has(m)) m.dispose();
    return { group: g, mats: mats.filter((m) => used.has(m)), kind: kind || 'sword', slot };
  }

  // Swap the held weapon / off-hand meshes when the equipment changes.
  syncPlayerEquipment(entry, player) {
    const w = player.equipment && player.equipment.weapon;
    const o = player.equipment && player.equipment.offhand;
    const sig = `${w ? (w.weaponKind || 'sword') : 'none'}|${w ? w.rarity : ''}|${o ? (o.offhandKind || 'shield') : 'none'}|${o ? o.rarity : ''}`;
    if (entry._equipSig === sig) return;
    entry._equipSig = sig;
    const a = entry.anim;
    for (const h of [entry._heldWeapon, entry._heldOff]) {
      if (!h) continue;
      h.group.parent && h.group.parent.remove(h.group);
      entry.materials = entry.materials.filter((m) => !h.mats.includes(m));
      for (const m of h.mats) m.dispose();
    }
    entry._heldWeapon = entry._heldOff = null;
    // Fallback: an unarmed hero still carries a plain sword so the silhouette reads as armed.
    const wk = w ? (w.weaponKind || 'sword') : 'sword';
    const hw = this.buildHeld(wk, w ? w.rarity : 'common', 'weapon');
    a.weaponMount.add(hw.group);
    entry._heldWeapon = hw;
    entry.materials.push(...hw.mats);
    // Per-kind resting grip angle (radians about the hand's x axis; ~1.2 = blade forward-up).
    entry._gripRest = wk === 'staff' ? 0.12 : wk === 'bow' ? 0.15 : 1.15;
    if (o) {
      const ok = o.offhandKind || 'shield';
      const ho = this.buildHeld(ok, o.rarity, 'offhand');
      if (ok === 'shield') { ho.group.rotation.set(0, 0.95, 0); ho.group.position.set(0.05, 0.02, 0.03); }
      else if (ok === 'tome') { ho.group.rotation.set(0.9, 0.3, 0); }
      else ho.group.rotation.set(0.2, 0, 0);
      a.offMount.add(ho.group);
      entry._heldOff = ho;
      entry.materials.push(...ho.mats);
    }
  }

  animatePlayer(entry, dt, moving, time) {
    const a = entry.anim;
    entry.moveAmt = lerp(entry.moveAmt || 0, moving ? 1 : 0, Math.min(1, dt * 10));
    entry.bobPhase = (entry.bobPhase || 0) + dt * (moving ? 9 : 2.2);
    const m = entry.moveAmt, ph = entry.bobPhase;
    const stride = Math.sin(ph) * 0.75 * m;
    a.legL.rotation.x = stride;
    a.legR.rotation.x = -stride;
    entry.root.position.y = Math.abs(Math.sin(ph)) * 0.05 * m + Math.sin(time * 2.2) * 0.006 * (1 - m);
    const breathe = Math.sin(time * 2.2) * 0.03 * (1 - m);

    // Rest pose.
    let rx = stride * 0.7 - 0.1, ry = 0, rz = -0.15 - breathe;
    let grip = entry._gripRest ?? 1.15;
    let twist = Math.sin(ph) * 0.08 * m;

    // Cleave swing: wind up to the right, sweep across to the left, recover.
    if (entry.swingT > 0) {
      entry.swingT = Math.max(0, entry.swingT - dt);
      const s = 1 - entry.swingT / SWING_DURATION;
      const w = s < 0.15 ? s / 0.15 : s > 0.65 ? (1 - s) / 0.35 : 1;
      const yaw = s < 0.25 ? lerp(-0.6, -1.5, s / 0.25) : lerp(-1.5, 1.25, easeOut(clamp01((s - 0.25) / 0.4)));
      rx = lerp(rx, -1.35, w);
      ry = lerp(ry, yaw, w);
      rz = lerp(rz, 0, w);
      grip = lerp(grip, 2.7, w);
      twist = lerp(twist, yaw * 0.3, w);
    }
    a.armR.rotation.set(rx, ry, rz);
    a.armL.rotation.set(-stride * 0.5 - 0.15, 0, 0.15 + breathe);
    a.weaponMount.rotation.x = grip;
    a.body.rotation.y = twist;
    a.head.rotation.y = -twist * 0.5;
    if (entry.cape) entry.cape.rotation.x = 0.1 + m * (0.3 + Math.sin(ph * 2) * 0.08) + Math.sin(time * 1.5) * 0.03;
  }

  // ================================================================== ENEMIES
  // Returns the anim-handle object; always sets anim.kind, anim.topY (model units) and anim.shadow.
  buildEnemy(enemy, root, materials, extraMats) {
    const shape = (enemy.visual && enemy.visual.shape) || 'blob';
    const color = col((enemy.visual && enemy.visual.color) || '#aa4444');
    const ctx = { root, materials, extraMats, color, enemy };
    switch (shape) {
      case 'slime': return this._slime(ctx);
      case 'bat': return this._bat(ctx);
      case 'goblin': return enemy.type === 'kobold_slinger' ? this._kobold(ctx) : this._goblin(ctx);
      case 'skeleton': return this._skeleton(ctx, enemy.type === 'skeleton_archer');
      case 'spider': return this._spider(ctx);
      case 'mage': return this._mage(ctx);
      case 'ogre': return this._ogre(ctx);
      case 'boss': return enemy.type === 'bone_tyrant' ? this._boneTyrant(ctx) : this._slimeKing(ctx);
      default: return this._blob(ctx);
    }
  }

  _blob({ root, materials, color }) {
    const mat = this.mat(color, { roughness: 0.6 }, materials);
    const body = this.single('sphere', mat, root, 0.6, [0, 0.3, 0]);
    return { kind: 'blob', body, topY: 0.6, shadow: 0.8 };
  }

  // ---------------------------------------------------------------- slime
  _slime({ root, materials, color }) {
    const gel = this.mat(color, { roughness: 0.15, metalness: 0.05, opacity: 0.84, emissive: darken(color, 0.25), emissiveIntensity: 0.6 }, materials);
    const solid = this.vmat(materials, { roughness: 0.35 });
    const body = this.pivot(root, 0, 0, 0);
    this.single('lootDisc', gel, root, [0.95, 1, 0.95], [0, 0.012, 0]);
    this.single('sphere', gel, body, [0.8, 0.7, 0.8], [0, 0.31, 0]);
    const core = this.mesh('slime_core', [
      P('sphere', darken(color, 0.55), 0.3, [0.03, 0.22, -0.05]),
      P('sphereLow', lighten(color, 0.5), 0.07, [-0.12, 0.3, -0.1]),
      P('sphereLow', lighten(color, 0.5), 0.05, [0.14, 0.4, 0.02]),
    ], solid, body);
    core.renderOrder = -0.5;
    this.mesh('slime_face', [
      P('sphereLow', 0xffffff, [0.15, 0.18, 0.08], [0.12, 0.36, 0.355]),
      P('sphereLow', 0xffffff, [0.15, 0.18, 0.08], [-0.12, 0.36, 0.355]),
      P('sphereLow', 0x1b1b2a, [0.085, 0.11, 0.05], [0.12, 0.35, 0.39]),
      P('sphereLow', 0x1b1b2a, [0.085, 0.11, 0.05], [-0.12, 0.35, 0.39]),
      P('sphereLow', 0xffffff, [0.03, 0.035, 0.02], [0.1, 0.38, 0.415]),
      P('sphereLow', 0xffffff, [0.03, 0.035, 0.02], [-0.14, 0.38, 0.415]),
      P('sphereLow', darken(color, 0.35), [0.08, 0.035, 0.03], [0, 0.24, 0.39]),
      P('sphere', lighten(color, 0.85), [0.16, 0.06, 0.11], [-0.14, 0.6, 0.06], [0.2, 0, 0.3]),
    ], solid, body);
    return { kind: 'slime', body, topY: 0.68, shadow: 0.85 };
  }

  // ---------------------------------------------------------------- bat
  _bat({ root, materials, color }) {
    const fur = this.vmat(materials, { roughness: 0.8 });
    const eyes = this.mat(0xfff06a, { emissive: 0xffd21f, emissiveIntensity: 0.9 }, materials);
    const wingMat = this.mat(darken(color, 0.75), { side: THREE.DoubleSide, roughness: 0.7 }, materials);
    const body = this.pivot(root, 0, 0.55, 0);
    this.mesh('bat_body', [
      P('sphere', color, [0.32, 0.3, 0.32], [0, 0, 0]),
      P('sphere', lighten(color, 0.35), [0.2, 0.2, 0.1], [0, -0.03, 0.12]),
      P('cone', color, [0.11, 0.2, 0.07], [0.09, 0.19, -0.01], [0, 0, -0.3]),
      P('cone', color, [0.11, 0.2, 0.07], [-0.09, 0.19, -0.01], [0, 0, 0.3]),
      P('cone', 0xff9ac4, [0.06, 0.12, 0.03], [0.09, 0.18, 0.02], [0, 0, -0.3]),
      P('cone', 0xff9ac4, [0.06, 0.12, 0.03], [-0.09, 0.18, 0.02], [0, 0, 0.3]),
      P('cone', 0xffffff, [0.03, 0.06, 0.03], [0.035, -0.08, 0.13], [Math.PI, 0, 0]),
      P('cone', 0xffffff, [0.03, 0.06, 0.03], [-0.035, -0.08, 0.13], [Math.PI, 0, 0]),
      P('sphereLow', darken(color, 0.6), [0.05, 0.08, 0.05], [0.05, -0.16, -0.02]),
      P('sphereLow', darken(color, 0.6), [0.05, 0.08, 0.05], [-0.05, -0.16, -0.02]),
    ], fur, body);
    this.mesh('bat_eyes', [
      P('sphereLow', 0xffffff, [0.07, 0.06, 0.04], [0.06, 0.04, 0.14]),
      P('sphereLow', 0xffffff, [0.07, 0.06, 0.04], [-0.06, 0.04, 0.14]),
    ], eyes, body);
    const wingL = new THREE.Mesh(this.geo.wing, wingMat);
    wingL.position.set(0.1, 0.02, 0);
    const wingR = new THREE.Mesh(this.geo.wing, wingMat);
    wingR.position.set(-0.1, 0.02, 0);
    wingR.scale.x = -1;
    body.add(wingL, wingR);
    const shadow = this.r._makeBlobShadow(0.55);
    root.add(shadow);
    return { kind: 'bat', body, wingL, wingR, shadowMesh: shadow, topY: 0.95, shadow: 0 };
  }

  // ---------------------------------------------------------------- goblin & kobold
  _goblinBody(ctx, key, skin, vest) {
    const { root, materials } = ctx;
    const mat = this.vmat(materials, { roughness: 0.7 });
    const legParts = [P('capsule', darken(skin, 0.8), [0.1, 0.07, 0.1], [0, -0.08, 0]), P('sphere', 0x5a3a22, [0.1, 0.07, 0.15], [0, -0.16, 0.03])];
    const legL = this.pivot(root, 0.08, 0.2, 0);
    const legR = this.pivot(root, -0.08, 0.2, 0);
    this.mesh(key + '_leg', legParts, mat, legL);
    this.mesh(key + '_leg', legParts, mat, legR);
    this.mesh(key + '_torso', [
      P('sphere', vest, [0.34, 0.32, 0.28], [0, 0.32, 0]),
      P('sphere', skin, [0.17, 0.2, 0.08], [0, 0.31, 0.11]),
      P('cylinder', 0x4a2e1a, [0.3, 0.045, 0.26], [0, 0.23, 0]),
      P('box', 0xd8b34a, [0.05, 0.05, 0.03], [0, 0.23, 0.13]),
    ], mat, root);
    const armParts = [P('capsule', skin, [0.08, 0.07, 0.08], [0, -0.07, 0]), P('sphereLow', skin, 0.09, [0, -0.16, 0])];
    const armL = this.pivot(root, 0.19, 0.4, 0, 'YXZ');
    const armR = this.pivot(root, -0.19, 0.4, 0, 'YXZ');
    this.mesh(key + '_arm', armParts, mat, armL);
    this.mesh(key + '_arm', armParts, mat, armR);
    armL.rotation.z = 0.25; armR.rotation.z = -0.25;
    const head = this.pivot(root, 0, 0.52, 0);
    return { mat, legL, legR, armL, armR, head };
  }

  _goblin(ctx) {
    const skin = ctx.color;
    const h = this._goblinBody(ctx, 'gob', skin, 0x8a5a2e);
    const earParts = (s) => [
      P('cone', skin, [0.1, 0.3, 0.06], [s * 0.24, 0.13, -0.02], [0, 0, s * (-Math.PI / 2 + 0.4)]),
      P('cone', 0xff9aa8, [0.05, 0.18, 0.03], [s * 0.22, 0.13, 0.0], [0, 0, s * (-Math.PI / 2 + 0.4)]),
    ];
    this.mesh('gob_head', [
      P('sphere', skin, [0.36, 0.32, 0.32], [0, 0.1, 0]),
      P('sphereLow', 0xfff27a, [0.09, 0.1, 0.05], [0.08, 0.13, 0.15]),
      P('sphereLow', 0xfff27a, [0.09, 0.1, 0.05], [-0.08, 0.13, 0.15]),
      P('sphereLow', 0x1b1b1b, [0.04, 0.055, 0.03], [0.08, 0.13, 0.172]),
      P('sphereLow', 0x1b1b1b, [0.04, 0.055, 0.03], [-0.08, 0.13, 0.172]),
      P('sphereLow', darken(skin, 0.85), [0.08, 0.07, 0.13], [0, 0.07, 0.18]),
      P('box', 0xffffff, [0.03, 0.035, 0.02], [0.04, 0.0, 0.15]),
      P('box', 0xffffff, [0.03, 0.035, 0.02], [-0.04, 0.0, 0.15]),
      P('cone', 0x5a3a22, [0.08, 0.1, 0.08], [0, 0.28, -0.02]),
    ], h.mat, h.head);
    const earL = this.mesh('gob_ear', earParts(1), h.mat, h.head);
    const earR = this.mesh('gob_earR', earParts(-1), h.mat, h.head);
    // Crude spiked club.
    const club = this.pivot(h.armR, 0, -0.17, 0);
    club.rotation.x = 1.0;
    this.mesh('gob_club', [
      P('frustum', 0x8a5a34, [0.09, 0.34, 0.09], [0, 0.14, 0], [Math.PI, 0, 0]),
      P('cone', 0xcfd6e2, [0.035, 0.06, 0.035], [0.05, 0.26, 0], [0, 0, -Math.PI / 2]),
      P('cone', 0xcfd6e2, [0.035, 0.06, 0.035], [-0.05, 0.22, 0], [0, 0, Math.PI / 2]),
      P('cone', 0xcfd6e2, [0.035, 0.06, 0.035], [0, 0.3, 0.05], [Math.PI / 2, 0, 0]),
    ], h.mat, club);
    return { kind: 'goblin', legL: h.legL, legR: h.legR, armL: h.armL, armR: h.armR, head: h.head, earL, earR, topY: 0.85, shadow: 0.75 };
  }

  _kobold(ctx) {
    const skin = ctx.color;
    const h = this._goblinBody(ctx, 'kob', skin, 0x6a4a8a);
    this.mesh('kob_head', [
      P('sphere', skin, [0.32, 0.3, 0.32], [0, 0.1, 0]),
      P('sphere', skin, [0.18, 0.13, 0.22], [0, 0.06, 0.16]),
      P('sphereLow', 0x1b1b1b, [0.03, 0.02, 0.02], [0.035, 0.09, 0.26]),
      P('sphereLow', 0x1b1b1b, [0.03, 0.02, 0.02], [-0.035, 0.09, 0.26]),
      P('sphereLow', 0xffe14a, [0.08, 0.08, 0.05], [0.1, 0.15, 0.12]),
      P('sphereLow', 0xffe14a, [0.08, 0.08, 0.05], [-0.1, 0.15, 0.12]),
      P('sphereLow', 0x1b1b1b, [0.025, 0.06, 0.03], [0.1, 0.15, 0.145]),
      P('sphereLow', 0x1b1b1b, [0.025, 0.06, 0.03], [-0.1, 0.15, 0.145]),
      P('cone', 0xf4ead0, [0.06, 0.16, 0.06], [0.09, 0.27, -0.06], [-0.6, 0, -0.3]),
      P('cone', 0xf4ead0, [0.06, 0.16, 0.06], [-0.09, 0.27, -0.06], [-0.6, 0, 0.3]),
      P('cylinder', 0xe8423f, [0.33, 0.06, 0.33], [0, 0.17, -0.01], [0.15, 0, 0]),
      P('cone', 0xe8423f, [0.06, 0.16, 0.03], [0.02, 0.14, -0.2], [-2.2, 0, 0.3]),
    ], h.mat, h.head);
    // Tail.
    const tail = this.pivot(ctx.root, 0, 0.22, -0.12);
    this.mesh('kob_tail', [P('cone', skin, [0.1, 0.34, 0.1], [0, 0, -0.16], [-Math.PI / 2 - 0.35, 0, 0])], h.mat, tail);
    // Sling: strap + stone pouch hanging from the throwing hand.
    const sling = this.pivot(h.armR, 0, -0.17, 0);
    this.mesh('kob_sling', [
      P('cylinder', 0x6b4423, [0.015, 0.2, 0.015], [0, -0.1, 0]),
      P('sphereLow', 0x8a6a4a, [0.07, 0.05, 0.07], [0, -0.2, 0]),
      P('sphereLow', 0x9a9aa6, 0.045, [0, -0.18, 0]),
    ], h.mat, sling);
    // Satchel of stones.
    this.mesh('kob_pouch', [P('sphere', 0x8a6a4a, [0.12, 0.12, 0.08], [0.15, 0.24, 0.05])], h.mat, ctx.root);
    return { kind: 'kobold', legL: h.legL, legR: h.legR, armL: h.armL, armR: h.armR, head: h.head, tail, sling, topY: 0.85, shadow: 0.72 };
  }

  // ---------------------------------------------------------------- skeleton & archer
  _skeleton(ctx, archer) {
    const { root, materials, color } = ctx;
    const bone = color, dark = 0x2a2530;
    const mat = this.vmat(materials, { roughness: 0.65 });
    const glowCol = archer ? 0x7fe7ff : 0x9dff8a;
    const eyeMat = this.mat(glowCol, { emissive: glowCol, emissiveIntensity: 1.2 }, materials);
    const k = archer ? 'ska' : 'sk';
    const legParts = [
      P('cyl6', bone, [0.06, 0.26, 0.06], [0, -0.13, 0]),
      P('octa', bone, 0.08, [0, -0.15, 0.01]),
      P('box', bone, [0.08, 0.05, 0.14], [0, -0.28, 0.03]),
    ];
    const legL = this.pivot(root, 0.08, 0.31, 0);
    const legR = this.pivot(root, -0.08, 0.31, 0);
    this.mesh('sk_leg', legParts, mat, legL);
    this.mesh('sk_leg', legParts, mat, legR);
    const body = this.pivot(root, 0, 0, 0);
    this.mesh('sk_body', [
      P('box', bone, [0.22, 0.08, 0.12], [0, 0.33, 0]),
      P('cyl6', bone, [0.05, 0.26, 0.05], [0, 0.46, -0.04]),
      P('rib', bone, [0.3, 0.3, 0.26], [0, 0.44, 0]),
      P('rib', bone, [0.34, 0.3, 0.28], [0, 0.5, 0]),
      P('rib', bone, [0.3, 0.3, 0.25], [0, 0.56, 0]),
      P('box', bone, [0.04, 0.16, 0.03], [0, 0.5, 0.13]),
      P('cyl6', bone, [0.045, 0.36, 0.045], [0, 0.61, 0], [0, 0, Math.PI / 2]),
      ...(archer ? [
        P('cylinder', 0x6b4423, [0.1, 0.34, 0.1], [0.07, 0.56, -0.14], [0.3, 0, -0.35]),
        P('cone', 0xf4f1e6, [0.05, 0.08, 0.02], [0.13, 0.76, -0.2], [0.3, 0, -0.35]),
        P('cone', 0xe8423f, [0.05, 0.08, 0.02], [0.1, 0.77, -0.2], [0.3, 0, -0.35]),
      ] : []),
    ], mat, body);
    const head = this.pivot(body, 0, 0.67, 0);
    this.mesh(k + '_head', [
      P('sphere', bone, [0.3, 0.27, 0.3], [0, 0.1, 0]),
      P('sphereLow', dark, [0.085, 0.09, 0.05], [0.065, 0.1, 0.125]),
      P('sphereLow', dark, [0.085, 0.09, 0.05], [-0.065, 0.1, 0.125]),
      P('octa', dark, [0.04, 0.05, 0.03], [0, 0.04, 0.145]),
      ...(archer ? [
        P('dome', 0x3e5a6e, [0.36, 0.36, 0.36], [0, 0.1, -0.02], [-0.25, 0, 0]),
        P('cone', 0x3e5a6e, [0.12, 0.2, 0.1], [0, 0.2, -0.17], [-2.0, 0, 0]),
      ] : []),
    ], mat, head);
    this.mesh('sk_eyes', [
      P('sphereLow', 0xffffff, 0.035, [0.065, 0.1, 0.14]),
      P('sphereLow', 0xffffff, 0.035, [-0.065, 0.1, 0.14]),
    ], eyeMat, head);
    const jaw = this.pivot(head, 0, 0.03, 0.02);
    this.mesh('sk_jaw', [
      P('box', bone, [0.16, 0.05, 0.12], [0, -0.02, 0.06]),
      P('box', 0xffffff, [0.13, 0.025, 0.02], [0, 0.01, 0.115]),
    ], mat, jaw);
    const armParts = [P('cyl6', bone, [0.045, 0.28, 0.045], [0, -0.14, 0]), P('sphereLow', bone, 0.07, [0, -0.29, 0])];
    const armL = this.pivot(body, 0.2, 0.6, 0, 'YXZ');
    const armR = this.pivot(body, -0.2, 0.6, 0, 'YXZ');
    this.mesh('sk_arm', armParts, mat, armL);
    this.mesh('sk_arm', armParts, mat, armR);
    armL.rotation.z = 0.12; armR.rotation.z = -0.12;
    if (archer) {
      const bow = this.pivot(armL, 0, -0.29, 0.02);
      bow.rotation.set(0.1, 0, 0);
      this.mesh('ska_bow', [
        P('bowThin', 0x7a4e2a, 0.56, [0, 0, 0], [0, -Math.PI / 2, -Math.PI / 2]),
        P('box', 0xf4f1e6, [0.012, 0.54, 0.012], [0, 0, -0.01]),
      ], mat, bow);
    } else {
      const sword = this.pivot(armR, 0, -0.29, 0.01);
      sword.rotation.x = 1.1;
      this.mesh('sk_sword', [
        P('box', 0xa3a7ad, [0.06, 0.34, 0.02], [0, 0.26, 0]),
        P('cone', 0xa3a7ad, [0.06, 0.07, 0.02], [0, 0.465, 0]),
        P('box', 0x6b4423, [0.16, 0.04, 0.05], [0, 0.08, 0]),
        P('cylinder', 0x4a2e1a, [0.04, 0.1, 0.04], [0, 0.02, 0]),
      ], mat, sword);
      const shield = this.pivot(armL, 0.04, -0.24, 0.03);
      shield.rotation.set(0, 0.9, 0);
      this.mesh('sk_shield', [
        P('cylinder', 0x8a5a34, [0.3, 0.05, 0.3], [0, 0, 0], [Math.PI / 2, 0, 0]),
        P('torus', 0x6d7078, [0.3, 0.3, 0.5]),
        P('sphereLow', 0x6d7078, [0.07, 0.07, 0.05], [0, 0, 0.03]),
      ], mat, shield);
    }
    return { kind: 'skeleton', body, head, jaw, legL, legR, armL, armR, topY: 0.92, shadow: 0.72 };
  }

  // ---------------------------------------------------------------- spider
  _spider({ root, materials, color }) {
    const mat = this.vmat(materials, { roughness: 0.55 });
    const eyeMat = this.mat(0xff5a8a, { emissive: 0xff2d6a, emissiveIntensity: 1.1 }, materials);
    const legCol = darken(color, 0.75), mark = mix(color, 0xffb13b, 0.75);
    const body = this.pivot(root, 0, 0, 0);
    this.mesh('sp_head', [
      P('sphere', color, [0.32, 0.22, 0.32], [0, 0.24, 0.12]),
      P('cone', 0xf4ead0, [0.04, 0.1, 0.04], [0.05, 0.14, 0.27], [Math.PI - 0.3, 0, 0]),
      P('cone', 0xf4ead0, [0.04, 0.1, 0.04], [-0.05, 0.14, 0.27], [Math.PI - 0.3, 0, 0]),
      P('sphere', lighten(color, 0.2), [0.12, 0.08, 0.1], [0, 0.35, 0.1]),
    ], mat, body);
    this.mesh('sp_eyes', [
      P('sphereLow', 0xffffff, 0.075, [0.055, 0.28, 0.265]),
      P('sphereLow', 0xffffff, 0.075, [-0.055, 0.28, 0.265]),
      P('sphereLow', 0xffffff, 0.045, [0.12, 0.31, 0.22]),
      P('sphereLow', 0xffffff, 0.045, [-0.12, 0.31, 0.22]),
      P('sphereLow', 0xffffff, 0.035, [0.03, 0.34, 0.24]),
      P('sphereLow', 0xffffff, 0.035, [-0.03, 0.34, 0.24]),
    ], eyeMat, body);
    const abdomen = this.pivot(body, 0, 0.32, -0.24);
    this.mesh('sp_abdomen', [
      P('sphere', color, [0.52, 0.42, 0.58], [0, 0, -0.04]),
      P('sphere', mark, [0.14, 0.05, 0.12], [0, 0.2, 0.08], [0.25, 0, 0]),
      P('sphere', mark, [0.12, 0.05, 0.12], [0, 0.205, -0.08], [-0.1, 0, 0]),
      P('sphere', mark, [0.08, 0.04, 0.08], [0.12, 0.17, -0.02], [0, 0, -0.5]),
      P('sphere', mark, [0.08, 0.04, 0.08], [-0.12, 0.17, -0.02], [0, 0, 0.5]),
      P('cone', darken(color, 0.6), [0.08, 0.08, 0.08], [0, -0.02, -0.31], [-Math.PI / 2, 0, 0]),
    ], mat, abdomen);
    const legParts = [
      seg('cyl6', legCol, [0, 0, 0], [0.24, 0.2, 0], 0.03),
      P('octa', lighten(legCol, 0.25), 0.07, [0.24, 0.2, 0]),
      seg('cyl6', legCol, [0.24, 0.2, 0], [0.44, -0.24, 0], 0.025),
      P('cone', darken(legCol, 0.6), [0.04, 0.06, 0.04], [0.445, -0.25, 0], [Math.PI, 0, 0]),
    ];
    const legGeo = this.bake('sp_leg', legParts);
    const legs = [];
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 4; i++) {
        const pv = this.pivot(body, side * 0.1, 0.25, 0.2 - i * 0.08);
        const theta = -0.75 + i * 0.5;
        const yaw = side > 0 ? theta : Math.PI - theta;
        pv.rotation.y = yaw;
        pv.add(new THREE.Mesh(legGeo, mat));
        legs.push({ pivot: pv, yaw, side, phase: ((i + (side > 0 ? 0 : 1)) % 2) * Math.PI + i * 0.3 });
      }
    }
    return { kind: 'spider', body, abdomen, legs, topY: 0.6, shadow: 1.0 };
  }

  // ---------------------------------------------------------------- mage
  _mage({ root, materials, extraMats, color }) {
    const mat = this.vmat(materials, { roughness: 0.75 });
    const orbCol = mix(color, 0xd88bff, 0.7);
    const glowMat = this.mat(0xffffff, { emissive: 0xffe066, emissiveIntensity: 1.3 }, materials);
    const orbMat = this.mat(lighten(orbCol, 0.3), { emissive: orbCol, emissiveIntensity: 1.4, roughness: 0.2 }, materials);
    const trim = 0xf0c040, robeLight = lighten(color, 0.25);
    const body = this.pivot(root, 0, 0, 0);
    this.mesh('mg_robe', [
      P('robe', color, [0.64, 0.64, 0.64], [0, 0.32, 0]),
      P('cylinder', trim, [0.65, 0.045, 0.65], [0, 0.04, 0]),
      P('cylinder', trim, [0.3, 0.04, 0.3], [0, 0.42, 0]),
      P('box', robeLight, [0.07, 0.42, 0.02], [0, 0.25, 0.235], [-0.33, 0, 0]),
    ], mat, body);
    const head = this.pivot(body, 0, 0.7, 0);
    this.mesh('mg_head', [
      P('sphere', 0x241634, [0.26, 0.25, 0.26], [0, 0, 0]),
      P('cone', 0xeef0f6, [0.18, 0.26, 0.1], [0, -0.14, 0.09], [Math.PI + 0.25, 0, 0]),
      P('cylinder', color, [0.58, 0.035, 0.58], [0, 0.09, 0]),
      P('cone', color, [0.3, 0.42, 0.3], [0, 0.31, -0.01], [-0.12, 0, 0]),
      P('cylinder', trim, [0.31, 0.05, 0.31], [0, 0.13, 0]),
      P('octa', trim, [0.07, 0.08, 0.03], [0, 0.22, 0.12]),
    ], mat, head);
    const hatTip = this.pivot(head, 0, 0.5, -0.06);
    this.mesh('mg_tip', [P('cone', color, [0.13, 0.2, 0.13], [0, 0.07, -0.03], [-0.7, 0, 0])], mat, hatTip);
    this.mesh('mg_eyes', [
      P('sphereLow', 0xffffff, [0.055, 0.03, 0.03], [0.05, 0.02, 0.12]),
      P('sphereLow', 0xffffff, [0.055, 0.03, 0.03], [-0.05, 0.02, 0.12]),
    ], glowMat, head);
    const sleeve = [P('robe', color, [0.16, 0.28, 0.16], [0, -0.12, 0]), P('sphereLow', 0xbfe8d8, 0.08, [0, -0.28, 0])];
    const armL = this.pivot(body, 0.16, 0.5, 0, 'YXZ');
    const armR = this.pivot(body, -0.16, 0.5, 0, 'YXZ');
    this.mesh('mg_arm', sleeve, mat, armL);
    this.mesh('mg_arm', sleeve, mat, armR);
    armL.rotation.set(-0.5, 0, 0.35);
    armR.rotation.set(-0.35, 0, -0.45);
    // Staff with a glowing orb in the right hand.
    const staff = this.pivot(body, -0.3, 0.3, 0.12);
    this.mesh('mg_staff', [
      P('cylinder', 0x5a4530, [0.035, 0.95, 0.035], [0, 0.18, 0]),
      P('cone', trim, [0.04, 0.12, 0.04], [0.05, 0.7, 0], [0, 0, -0.5]),
      P('cone', trim, [0.04, 0.12, 0.04], [-0.05, 0.7, 0], [0, 0, 0.5]),
      P('cone', trim, [0.04, 0.12, 0.04], [0, 0.7, 0.05], [0.5, 0, 0]),
    ], mat, staff);
    const orb = this.single('sphere', orbMat, staff, 0.15, [0, 0.76, 0]);
    const orbGlow = this.glow(orbCol, 0.7, 0.7, extraMats, staff, [0, 0.76, 0]);
    const sparkles = this.pivot(staff, 0, 0.76, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      this.single('octa', orbMat, sparkles, 0.04, [Math.cos(a) * 0.15, (i - 1) * 0.04, Math.sin(a) * 0.15]);
    }
    return { kind: 'mage', body, head, hatTip, armL, armR, staff, orb, orbGlow, sparkles, topY: 1.2, shadow: 0.75 };
  }

  // ---------------------------------------------------------------- ogre
  _ogre({ root, materials, color }) {
    const mat = this.vmat(materials, { roughness: 0.75 });
    const skin = color, cloth = 0x6a5236, belt = 0x3e2a1a, tusk = 0xfaf3dd;
    const legParts = [P('capsule', skin, [0.2, 0.13, 0.2], [0, -0.1, 0]), P('sphere', darken(skin, 0.75), [0.2, 0.1, 0.26], [0, -0.21, 0.05])];
    const legL = this.pivot(root, 0.14, 0.26, 0);
    const legR = this.pivot(root, -0.14, 0.26, 0);
    this.mesh('og_leg', legParts, mat, legL);
    this.mesh('og_leg', legParts, mat, legR);
    const body = this.pivot(root, 0, 0, 0);
    this.mesh('og_body', [
      P('sphere', skin, [0.66, 0.6, 0.56], [0, 0.5, 0.02]),
      P('sphere', skin, [0.78, 0.36, 0.5], [0, 0.72, -0.04]),
      P('sphere', lighten(skin, 0.18), [0.4, 0.34, 0.2], [0, 0.48, 0.2]),
      P('frustum', cloth, [0.52, 0.18, 0.46], [0, 0.3, 0]),
      P('cylinder', belt, [0.56, 0.06, 0.5], [0, 0.37, 0]),
      P('box', 0xc9a13b, [0.1, 0.08, 0.04], [0, 0.37, 0.26]),
      P('box', cloth, [0.2, 0.2, 0.03], [0, 0.2, 0.2], [0.1, 0, 0]),
    ], mat, body);
    const head = this.pivot(body, 0, 0.86, 0.12);
    this.mesh('og_head', [
      P('sphere', skin, [0.36, 0.32, 0.34], [0, 0, 0]),
      P('box', darken(skin, 0.75), [0.2, 0.045, 0.06], [0, 0.075, 0.15]),
      P('sphereLow', 0xffffff, [0.06, 0.05, 0.03], [0.075, 0.03, 0.16]),
      P('sphereLow', 0xffffff, [0.06, 0.05, 0.03], [-0.075, 0.03, 0.16]),
      P('sphereLow', 0x1b1b1b, [0.03, 0.03, 0.02], [0.075, 0.03, 0.172]),
      P('sphereLow', 0x1b1b1b, [0.03, 0.03, 0.02], [-0.075, 0.03, 0.172]),
      P('sphere', darken(skin, 0.9), [0.11, 0.08, 0.09], [0, -0.01, 0.18]),
      P('cone', tusk, [0.05, 0.11, 0.05], [0.08, -0.07, 0.15], [0, 0, -0.2]),
      P('cone', tusk, [0.05, 0.11, 0.05], [-0.08, -0.07, 0.15], [0, 0, 0.2]),
      P('sphereLow', skin, [0.06, 0.1, 0.05], [0.18, 0.02, 0]),
      P('sphereLow', skin, [0.06, 0.1, 0.05], [-0.18, 0.02, 0]),
      P('cone', 0x2a1a10, [0.12, 0.16, 0.12], [0, 0.2, -0.05]),
      P('cylinder', 0xc9a13b, [0.08, 0.03, 0.08], [0, 0.14, -0.05]),
    ], mat, head);
    const armParts = [P('capsule', skin, [0.19, 0.15, 0.19], [0, -0.16, 0]), P('sphere', darken(skin, 0.9), 0.22, [0, -0.38, 0.02])];
    const armL = this.pivot(body, 0.4, 0.74, 0, 'YXZ');
    const armR = this.pivot(body, -0.4, 0.74, 0, 'YXZ');
    this.mesh('og_arm', armParts, mat, armL);
    this.mesh('og_arm', armParts, mat, armR);
    armL.rotation.z = 0.15; armR.rotation.z = -0.15;
    // Big studded club resting up over the shoulder.
    const club = this.pivot(armR, 0, -0.38, 0.02);
    club.rotation.x = -0.35;
    const cm = [
      P('frustum', 0x8a5a34, [0.14, 0.2, 0.14], [0, 0.0, 0], [Math.PI, 0, 0]),
      P('frustum', 0x9a6a3e, [0.22, 0.5, 0.22], [0, 0.35, 0], [Math.PI, 0, 0]),
    ];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      cm.push(P('cone', 0xcfd6e2, [0.05, 0.09, 0.05], [Math.cos(a) * 0.11, 0.45 + (i % 2) * 0.08, Math.sin(a) * 0.11], [Math.sin(a) * 1.4, 0, -Math.cos(a) * 1.4]));
    }
    this.mesh('og_club', cm, mat, club);
    return { kind: 'ogre', body, head, legL, legR, armL, armR, topY: 1.1, shadow: 1.15 };
  }

  // ---------------------------------------------------------------- Slime King
  _slimeKing({ root, materials, color }) {
    const gel = this.mat(color, { roughness: 0.1, metalness: 0.05, opacity: 0.84, emissive: darken(color, 0.3), emissiveIntensity: 0.55 }, materials);
    const puddle = this.mat(darken(color, 0.9), { roughness: 0.1, opacity: 0.6 }, materials);
    const solid = this.vmat(materials, { roughness: 0.35 });
    const eyeMat = this.mat(0xffffff, { roughness: 0.3 }, materials);
    const gold = this.vmat(materials, { roughness: 0.25, metalness: 0.6, emissive: 0x6a4a00, emissiveIntensity: 0.35, side: THREE.DoubleSide });
    const gemMat = this.vmat(materials, { roughness: 0.2, emissive: 0xffffff, emissiveIntensity: 0.35 });
    const bubbleMat = this.mat(lighten(color, 0.7), { opacity: 0.75, roughness: 0.1, emissive: lighten(color, 0.3), emissiveIntensity: 0.3 }, materials);

    this.single('lootDisc', puddle, root, [1.5, 1, 1.5], [0, 0.014, 0]);
    // Goo droplets around the base.
    this.mesh('skg_drops', [
      P('sphereLow', 0xffffff, [0.14, 0.08, 0.14], [0.66, 0.02, 0.2]),
      P('sphereLow', 0xffffff, [0.1, 0.06, 0.1], [-0.6, 0.02, 0.34]),
      P('sphereLow', 0xffffff, [0.12, 0.07, 0.12], [-0.4, 0.02, -0.55]),
      P('sphereLow', 0xffffff, [0.08, 0.05, 0.08], [0.35, 0.02, -0.62]),
    ], this.mat(color, { roughness: 0.1, opacity: 0.85 }, materials), root);

    const body = this.pivot(root, 0, 0, 0);
    this.single('sphereHi', gel, body, [1.3, 1.0, 1.3], [0, 0.46, 0]);
    // Things it has swallowed, visible through the gel.
    const inner = this.mesh('skg_inner', [
      P('sphere', darken(color, 0.55), [0.55, 0.45, 0.55], [0, 0.38, -0.1]),
      P('cylinder', 0xffd23f, [0.17, 0.03, 0.17], [0.24, 0.26, 0.12], [0.9, 0, 0.4]),
      P('cylinder', 0xffd23f, [0.15, 0.03, 0.15], [0.3, 0.2, -0.05], [0.3, 0, 1.1]),
      P('cylinder', 0xf4f1e6, [0.05, 0.36, 0.05], [-0.26, 0.34, 0.05], [0.4, 0, 1.0]),
      P('sphereLow', 0xf4f1e6, 0.08, [-0.4, 0.42, 0.13]),
      P('sphereLow', 0xf4f1e6, 0.08, [-0.12, 0.26, -0.03]),
      P('box', 0xcfd6e2, [0.04, 0.3, 0.02], [0.05, 0.5, -0.3], [0.3, 0.5, -0.6]),
    ], solid, body);
    inner.renderOrder = -0.5;
    const bubbles = [];
    for (let i = 0; i < 5; i++) {
      const b = this.single('sphereLow', bubbleMat, body, 0.08, [0, 0, 0]);
      b.renderOrder = -0.4;
      const a = i * 2.4;
      bubbles.push({ mesh: b, x: Math.cos(a) * (0.15 + 0.07 * i), z: Math.sin(a) * (0.12 + 0.05 * i), speed: 0.18 + 0.05 * i, off: i * 0.21, size: 0.06 + (i % 3) * 0.025 });
    }
    // Big angry eyes + grin.
    this.mesh('skg_sclera', [
      P('sphere', 0xffffff, [0.26, 0.3, 0.14], [0.21, 0.6, 0.56]),
      P('sphere', 0xffffff, [0.26, 0.3, 0.14], [-0.21, 0.6, 0.56]),
    ], eyeMat, body);
    this.mesh('skg_face', [
      P('sphereLow', 0x14141f, [0.13, 0.16, 0.06], [0.2, 0.58, 0.63]),
      P('sphereLow', 0x14141f, [0.13, 0.16, 0.06], [-0.2, 0.58, 0.63]),
      P('sphereLow', 0xffffff, [0.045, 0.05, 0.02], [0.17, 0.62, 0.66]),
      P('sphereLow', 0xffffff, [0.045, 0.05, 0.02], [-0.23, 0.62, 0.66]),
      P('box', darken(color, 0.35), [0.24, 0.05, 0.05], [0.2, 0.79, 0.53], [0, 0, 0.35]),
      P('box', darken(color, 0.35), [0.24, 0.05, 0.05], [-0.2, 0.79, 0.53], [0, 0, -0.35]),
      P('sphere', darken(color, 0.3), [0.36, 0.1, 0.08], [0, 0.36, 0.6]),
      P('box', 0xffffff, [0.05, 0.04, 0.02], [0.08, 0.39, 0.635]),
      P('box', 0xffffff, [0.05, 0.04, 0.02], [-0.08, 0.39, 0.635]),
      P('sphere', lighten(color, 0.9), [0.3, 0.1, 0.18], [-0.24, 0.88, 0.2], [0.35, 0, 0.45]),
    ], solid, body);
    // Crown, tilted jauntily on top.
    const crown = this.pivot(body, 0.06, 0.9, -0.04);
    crown.rotation.z = -0.18;
    crown.scale.setScalar(0.85);
    const cParts = [P('band', 0xffcc33, [0.52, 0.14, 0.52], [0, 0.07, 0]), P('torus', 0xffe27a, [0.53, 0.53, 0.5], [0, 0.0, 0], [Math.PI / 2, 0, 0])];
    const gParts = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
      cParts.push(P('cone', 0xffcc33, [0.1, 0.2, 0.1], [Math.cos(a) * 0.24, 0.22, Math.sin(a) * 0.24]));
      gParts.push(P('sphereLow', 0xffe27a, 0.06, [Math.cos(a) * 0.245, 0.33, Math.sin(a) * 0.245]));
      gParts.push(P('octa', i % 2 ? 0x3a8cff : 0xff3d8b, [0.07, 0.08, 0.04], [Math.cos(a) * 0.265, 0.08, Math.sin(a) * 0.265], [0, -a + Math.PI / 2, 0]));
    }
    this.mesh('skg_crown', cParts, gold, crown);
    this.mesh('skg_gems', gParts, gemMat, crown);
    return { kind: 'slimeKing', body, crown, bubbles, eyeMat, topY: 1.3, shadow: 1.7 };
  }

  // ---------------------------------------------------------------- Bone Tyrant
  _boneTyrant({ root, materials, extraMats, color }) {
    const bone = color, boneD = darken(color, 0.72), horn = 0x4a3a5a, iron = 0x6e6a88, cloth = 0x5a2d7a, gold = 0xd8a83b;
    const mat = this.vmat(materials, { roughness: 0.6 });
    const metal = this.vmat(materials, { roughness: 0.35, metalness: 0.55 });
    const SOUL = 0x5ff7ff;
    const soulMat = this.mat(0xc8ffff, { emissive: SOUL, emissiveIntensity: 1.5, roughness: 0.3 }, materials);
    const capeMat = this.mat(cloth, { side: THREE.DoubleSide, roughness: 0.85 }, materials);

    const legParts = [
      P('cyl6', bone, [0.09, 0.2, 0.09], [0, -0.1, 0]),
      P('octa', boneD, 0.12, [0, -0.2, 0.02]),
      P('cyl6', bone, [0.075, 0.18, 0.075], [0, -0.3, 0]),
      P('box', bone, [0.13, 0.07, 0.22], [0, -0.4, 0.05]),
    ];
    const legL = this.pivot(root, 0.14, 0.43, 0);
    const legR = this.pivot(root, -0.14, 0.43, 0);
    this.mesh('bt_leg', legParts, mat, legL);
    this.mesh('bt_leg', legParts, mat, legR);

    const body = this.pivot(root, 0, 0, 0);
    this.mesh('bt_body', [
      P('sphere', bone, [0.36, 0.14, 0.24], [0, 0.45, 0]),
      P('cyl6', bone, [0.07, 0.42, 0.07], [0, 0.64, -0.08]),
      P('rib', bone, [0.42, 0.4, 0.36], [0, 0.6, 0]),
      P('rib', bone, [0.5, 0.4, 0.42], [0, 0.68, 0]),
      P('rib', bone, [0.52, 0.4, 0.42], [0, 0.76, 0]),
      P('rib', bone, [0.44, 0.4, 0.36], [0, 0.84, 0]),
      P('box', bone, [0.06, 0.26, 0.04], [0, 0.72, 0.19]),
      P('box', cloth, [0.26, 0.24, 0.03], [0, 0.34, 0.13], [0.08, 0, 0]),
      P('box', cloth, [0.3, 0.22, 0.03], [0, 0.35, -0.13], [-0.08, 0, 0]),
    ], mat, body);
    this.mesh('bt_armor', [
      P('dome', iron, [0.34, 0.28, 0.34], [0.33, 0.9, 0], [0, 0, -0.25]),
      P('dome', iron, [0.34, 0.28, 0.34], [-0.33, 0.9, 0], [0, 0, 0.25]),
      P('cone', 0xcfd0d8, [0.08, 0.22, 0.08], [0.38, 1.03, 0.0], [0, 0, -0.45]),
      P('cone', 0xcfd0d8, [0.08, 0.22, 0.08], [-0.38, 1.03, 0.0], [0, 0, 0.45]),
      P('cone', 0xcfd0d8, [0.06, 0.16, 0.06], [0.44, 0.96, -0.08], [-0.3, 0, -0.9]),
      P('cone', 0xcfd0d8, [0.06, 0.16, 0.06], [-0.44, 0.96, -0.08], [-0.3, 0, 0.9]),
      P('cylinder', gold, [0.46, 0.05, 0.3], [0, 0.9, 0]),
    ], metal, body);
    const soul = this.single('sphere', soulMat, body, 0.2, [0, 0.72, 0]);
    const soulGlow = this.glow(SOUL, 0.6, 0.45, extraMats, body, [0, 0.72, 0]);
    const cape = new THREE.Mesh(this.geo.tatteredCape, capeMat);
    cape.scale.set(0.62, 0.7, 1);
    cape.position.set(0, 0.95, -0.2);
    cape.rotation.x = 0.12;
    body.add(cape);

    const head = this.pivot(body, 0, 1.12, 0.0);
    head.scale.setScalar(0.88);
    this.mesh('bt_head', [
      P('sphere', bone, [0.42, 0.38, 0.42], [0, 0.12, 0]),
      P('sphere', bone, [0.3, 0.14, 0.2], [0, 0.03, 0.1]),
      P('sphereLow', 0x1a1622, [0.12, 0.11, 0.06], [0.09, 0.12, 0.17]),
      P('sphereLow', 0x1a1622, [0.12, 0.11, 0.06], [-0.09, 0.12, 0.17]),
      P('octa', 0x1a1622, [0.05, 0.06, 0.03], [0, 0.04, 0.205]),
      P('box', boneD, [0.14, 0.03, 0.05], [0.1, 0.19, 0.17], [0, 0, 0.3]),
      P('box', boneD, [0.14, 0.03, 0.05], [-0.1, 0.19, 0.17], [0, 0, -0.3]),
      // Horns sweeping out then up.
      P('cone', horn, [0.12, 0.26, 0.12], [0.24, 0.24, -0.02], [0, 0, -1.15]),
      P('cone', horn, [0.12, 0.26, 0.12], [-0.24, 0.24, -0.02], [0, 0, 1.15]),
      P('cone', horn, [0.085, 0.22, 0.085], [0.38, 0.38, -0.02], [0, 0, -0.25]),
      P('cone', horn, [0.085, 0.22, 0.085], [-0.38, 0.38, -0.02], [0, 0, 0.25]),
    ], mat, head);
    const crownParts = [P('band', gold, [0.34, 0.08, 0.34], [0, 0.3, -0.01])];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
      crownParts.push(P('cone', gold, [0.06, 0.13, 0.06], [Math.cos(a) * 0.16, 0.39, Math.sin(a) * 0.16 - 0.01]));
    }
    this.mesh('bt_crown', crownParts, this.vmat(materials, { roughness: 0.3, metalness: 0.6, emissive: 0x5a3a00, emissiveIntensity: 0.3, side: THREE.DoubleSide }), head);
    const eyeMat = this.mat(0xe8ffff, { emissive: SOUL, emissiveIntensity: 1.6 }, materials);
    this.mesh('bt_eyes', [
      P('sphereLow', 0xffffff, 0.06, [0.09, 0.12, 0.19]),
      P('sphereLow', 0xffffff, 0.06, [-0.09, 0.12, 0.19]),
    ], eyeMat, head);
    const eyeGlows = [
      this.glow(SOUL, 0.22, 0.7, extraMats, head, [0.09, 0.12, 0.22]),
      this.glow(SOUL, 0.22, 0.7, extraMats, head, [-0.09, 0.12, 0.22]),
    ];
    const jaw = this.pivot(head, 0, -0.02, 0.04);
    this.mesh('bt_jaw', [
      P('box', bone, [0.26, 0.07, 0.2], [0, -0.03, 0.06]),
      P('box', 0xffffff, [0.22, 0.03, 0.02], [0, 0.01, 0.16]),
    ], mat, jaw);

    const armParts = [
      P('cyl6', bone, [0.085, 0.24, 0.085], [0, -0.12, 0]),
      P('octa', boneD, 0.12, [0, -0.25, 0]),
      P('cyl6', bone, [0.07, 0.22, 0.07], [0.02, -0.37, 0]),
      P('cyl6', bone, [0.05, 0.22, 0.05], [-0.03, -0.37, 0]),
      P('sphere', bone, [0.16, 0.12, 0.16], [0, -0.5, 0.02]),
      P('cone', bone, [0.04, 0.1, 0.04], [0.05, -0.58, 0.06], [Math.PI, 0, 0]),
      P('cone', bone, [0.04, 0.1, 0.04], [-0.05, -0.58, 0.06], [Math.PI, 0, 0]),
      P('cone', bone, [0.04, 0.1, 0.04], [0, -0.58, -0.03], [Math.PI, 0, 0]),
    ];
    const armL = this.pivot(body, 0.42, 0.88, 0, 'YXZ');
    const armR = this.pivot(body, -0.42, 0.88, 0, 'YXZ');
    this.mesh('bt_arm', armParts, mat, armL);
    this.mesh('bt_arm', armParts, mat, armR);
    armL.rotation.z = 0.2; armR.rotation.z = -0.2;
    // Giant femur club.
    const club = this.pivot(armR, 0, -0.5, 0.03);
    club.rotation.set(0.9, 0, 0.5);
    this.mesh('bt_club', [
      P('cyl6', bone, [0.1, 0.78, 0.1], [0, 0.28, 0]),
      P('sphere', bone, [0.2, 0.2, 0.2], [0.08, 0.68, 0]),
      P('sphere', bone, [0.2, 0.2, 0.2], [-0.08, 0.68, 0]),
      P('sphere', bone, [0.12, 0.12, 0.12], [0.05, -0.1, 0]),
      P('sphere', bone, [0.12, 0.12, 0.12], [-0.05, -0.1, 0]),
      P('cylinder', iron, [0.14, 0.06, 0.14], [0, 0.45, 0]),
      P('cone', 0xcfd0d8, [0.06, 0.12, 0.06], [0, 0.55, 0.09], [Math.PI / 2, 0, 0]),
      P('cone', 0xcfd0d8, [0.06, 0.12, 0.06], [0, 0.55, -0.09], [-Math.PI / 2, 0, 0]),
    ], mat, club);
    return { kind: 'boneTyrant', body, head, jaw, legL, legR, armL, armR, club, cape, soul, soulGlow, eyeGlows, eyeMat, soulMat, topY: 1.45, shadow: 1.6 };
  }

  // ---------------------------------------------------------------- elite marker
  addEliteMarker(root, anim, materials) {
    const gemMat = this.mat(0xffd34f, { emissive: 0xffb020, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.4 }, materials);
    const gem = this.pivot(root, 0, (anim.topY || 0.9) + 0.2, 0);
    this.single('octa', gemMat, gem, [0.13, 0.2, 0.13]);
    anim.eliteGem = gem;
    anim.eliteGemY = gem.position.y;
  }

  // ---------------------------------------------------------------- per-frame enemy animation
  animateEnemy(entry, enemy, dt, moving, t) {
    const a = entry.anim;
    entry.bobPhase = (entry.bobPhase !== undefined ? entry.bobPhase : Math.random() * 10) + dt * (moving ? 8 : 2.5);
    entry.moveAmt = lerp(entry.moveAmt || 0, moving ? 1 : 0, Math.min(1, dt * 10));
    const ph = entry.bobPhase, m = entry.moveAmt, root = entry.root;
    const stride = (amp) => Math.sin(ph * 1.6) * amp * m;
    switch (a.kind) {
      case 'slime': {
        let sy, sxz;
        if (m > 0.05) {
          const h = Math.abs(Math.sin(ph * 0.9));
          root.position.y = h * 0.14 * m;
          const st = (h - 0.5) * 2 * 0.12 * m;
          sy = 1 + st; sxz = 1 - st * 0.5;
        } else {
          const s = Math.sin(ph * 1.6);
          root.position.y = 0;
          sy = 1 + 0.08 * s; sxz = 1 - 0.05 * s;
        }
        a.body.scale.set(sxz, sy, sxz);
        break;
      }
      case 'bat': {
        const hover = 0.28 + Math.sin(t * 3 + ph) * 0.07;
        root.position.y = hover;
        const flap = Math.sin(t * 16 + ph * 3);
        a.wingL.rotation.z = 0.15 + flap * 0.75;
        a.wingR.rotation.z = -(0.15 + flap * 0.75);
        a.body.position.y = 0.55 + flap * 0.025;
        a.body.rotation.x = 0.1 + 0.3 * m;
        a.shadowMesh.position.y = (0.012 - hover) / Math.max(0.01, entry.baseScale || 1);
        const sh = 1 - hover * 0.4;
        a.shadowMesh.scale.set(0.55 * sh, 1, 0.55 * sh);
        break;
      }
      case 'goblin':
      case 'kobold': {
        const s = stride(0.8);
        a.legL.rotation.x = s; a.legR.rotation.x = -s;
        a.armL.rotation.x = -s * 0.8; a.armR.rotation.x = s * 0.6 - 0.2;
        root.position.y = Math.abs(Math.sin(ph * 1.6)) * 0.07 * m;
        a.head.rotation.z = Math.sin(t * 1.7 + ph) * 0.08 * (1 - m);
        a.head.rotation.x = Math.sin(t * 2.3 + ph) * 0.05;
        if (a.earL) {
          const tw = Math.pow(Math.max(0, Math.sin(t * 1.3 + ph * 2)), 12) * 0.35;
          a.earL.rotation.z = tw; a.earR.rotation.z = -tw;
        }
        if (a.tail) a.tail.rotation.y = Math.sin(t * 3 + ph) * 0.35;
        if (a.sling) a.sling.rotation.y = t * (enemy.state === 'attack' ? 14 : 2);
        break;
      }
      case 'skeleton': {
        const s = stride(0.6);
        a.legL.rotation.x = -s; a.legR.rotation.x = s;
        a.armL.rotation.x = s * 0.8 - 0.1; a.armR.rotation.x = -s * 0.8 - 0.1;
        root.position.y = Math.abs(Math.sin(ph * 1.6)) * 0.04 * m;
        const burst = Math.sin(t * 0.8 + ph) > 0.55 ? 1 : 0.2;
        a.head.rotation.z = Math.sin(t * 17 + ph) * 0.05 * burst;
        a.head.rotation.y = Math.sin(t * 0.9 + ph) * 0.25 * (1 - m);
        a.jaw.rotation.x = Math.max(0, Math.sin(t * 11 + ph)) * 0.35 * burst;
        a.body.position.y = Math.sin(t * 19 + ph) * 0.006 * burst;
        break;
      }
      case 'spider': {
        const speed = m > 0.05 ? 16 : 3;
        const amp = m > 0.05 ? 0.4 : 0.08;
        for (const leg of a.legs) {
          const w = Math.sin(t * speed + leg.phase + ph);
          leg.pivot.rotation.z = Math.max(0, w) * amp;
          leg.pivot.rotation.y = leg.yaw + Math.cos(t * speed + leg.phase + ph) * amp * 0.35 * leg.side;
        }
        root.position.y = Math.abs(Math.sin(t * speed * 0.5 + ph)) * 0.02 * (m > 0.05 ? 1 : 0.3);
        const br = 1 + Math.sin(t * 2 + ph) * 0.04;
        a.abdomen.scale.set(br, br, br);
        a.abdomen.rotation.x = Math.sin(t * 1.3 + ph) * 0.05;
        break;
      }
      case 'mage': {
        root.position.y = 0.05 + Math.sin(ph * 0.8) * 0.035;
        a.body.rotation.z = Math.sin(t * 1.4 + ph) * 0.05;
        a.body.rotation.x = 0.1 * m;
        a.hatTip.rotation.x = Math.sin(t * 2.1 + ph) * 0.2;
        a.hatTip.rotation.z = Math.sin(t * 1.6 + ph) * 0.15;
        a.sparkles.rotation.y += dt * 2.5;
        const casting = (enemy._cast || 0) > 0;
        entry._castAmt = lerp(entry._castAmt || 0, casting ? 1 : 0, Math.min(1, dt * 8));
        const c = entry._castAmt;
        a.staff.rotation.x = -0.45 * c;
        a.staff.rotation.z = Math.sin(t * 1.4 + ph) * 0.05;
        a.armR.rotation.x = -0.35 - 0.7 * c;
        a.armL.rotation.x = -0.5 - 0.9 * c;
        const pulse = 0.5 + 0.5 * Math.sin(t * 4 + ph);
        a.orbGlow.material.opacity = (0.45 + 0.3 * pulse + 0.3 * c) * (entry._fade ?? 1);
        a.orbGlow.scale.setScalar(0.65 + 0.15 * pulse + 0.45 * c);
        a.orb.scale.setScalar(0.15 * (1 + 0.1 * pulse + 0.3 * c));
        break;
      }
      case 'ogre': {
        const s = Math.sin(ph * 1.1) * 0.45 * m;
        a.legL.rotation.x = s; a.legR.rotation.x = -s;
        root.position.y = Math.abs(Math.sin(ph * 1.1)) * 0.05 * m;
        a.body.rotation.z = Math.sin(ph * 1.1) * 0.06 * m + Math.sin(t * 1.3 + ph) * 0.035 * (1 - m);
        const br = 1 + Math.sin(t * 1.8 + ph) * 0.02;
        a.body.scale.set(1 / Math.sqrt(br), br, 1 / Math.sqrt(br));
        a.head.rotation.y = Math.sin(t * 0.7 + ph) * 0.2 * (1 - m);
        const wind = (enemy._windup || 0) > 0;
        entry._windAmt = lerp(entry._windAmt || 0, wind ? 1 : 0, Math.min(1, dt * (wind ? 6 : 12)));
        const w = entry._windAmt;
        a.armL.rotation.x = -s * 0.7;
        a.armR.rotation.x = lerp(s * 0.7, -2.5, w);
        a.body.rotation.x = -0.15 * w;
        break;
      }
      case 'slimeKing': {
        const p2 = enemy._phase >= 2;
        const sp = p2 ? 1.6 : 1;
        const j = 0.04 * Math.sin(t * 2.2 * sp) + 0.02 * Math.sin(t * 5.3 * sp + 1);
        let sy = 1 - j * 1.4, sxz = 1 + j;
        const arc = entry._hopArcY || 0;
        if (entry._prevArc > 0.05 && arc <= 0.001) entry._landT = 0.35;
        entry._prevArc = arc;
        if (arc > 0) { sy *= 1 + arc * 0.3; sxz *= 1 - arc * 0.12; }
        const crouch = enemy._activeAttack === 'hopSlam' && enemy._atkSub === 'telegraph';
        entry._crouch = lerp(entry._crouch || 0, crouch ? 1 : 0, Math.min(1, dt * 6));
        sy *= 1 - 0.15 * entry._crouch; sxz *= 1 + 0.08 * entry._crouch;
        if (entry._landT > 0) {
          entry._landT = Math.max(0, entry._landT - dt);
          const k = entry._landT / 0.35;
          sy *= 1 - 0.3 * k; sxz *= 1 + 0.18 * k;
        }
        a.body.scale.set(sxz, sy, sxz);
        a.crown.rotation.z = -0.18 + j * 2 + (arc > 0 ? -arc * 0.15 : 0);
        a.crown.position.y = 0.9 + arc * 0.08;
        root.position.y = Math.abs(Math.sin(ph * 0.6)) * 0.06 * m + arc;
        for (const b of a.bubbles) {
          const u = ((t * b.speed * sp + b.off) % 1);
          b.mesh.position.set(b.x + Math.sin(t * 3 + b.off * 9) * 0.03, 0.12 + u * 0.72, b.z);
          b.mesh.scale.setScalar(b.size * (0.6 + u * 0.8));
        }
        if (p2 && !entry._p2) {
          entry._p2 = true;
          a.eyeMat.color.setHex(0xffd0a0);
          a.eyeMat.userData.baseEmissive.setHex(0xff6a00);
          a.eyeMat.userData.baseEmissiveIntensity = 1.3;
        }
        break;
      }
      case 'boneTyrant': {
        const p2 = enemy._phase >= 2;
        const s = Math.sin(ph * 1.1) * 0.5 * m;
        a.legL.rotation.x = s; a.legR.rotation.x = -s;
        const breath = Math.sin(t * 1.6 + ph);
        a.body.position.y = breath * 0.012;
        const charging = enemy._activeAttack === 'boneCharge' && enemy._atkSub === 'charging';
        const spears = enemy._activeAttack === 'boneSpears' || enemy._activeAttack === 'spiral';
        const dazed = (enemy._dazedTime || 0) > 0;
        entry._lean = lerp(entry._lean || 0, charging ? 1 : 0, Math.min(1, dt * 8));
        entry._raise = lerp(entry._raise || 0, spears ? 1 : 0, Math.min(1, dt * 6));
        entry._daze = lerp(entry._daze || 0, dazed ? 1 : 0, Math.min(1, dt * 5));
        a.body.rotation.x = 0.35 * entry._lean + 0.12 * entry._daze;
        a.body.rotation.z = Math.sin(ph * 1.1) * 0.05 * m;
        a.armR.rotation.x = lerp(-s * 0.6 - 0.35, -2.4, entry._raise) + 0.6 * entry._lean;
        a.armL.rotation.x = lerp(s * 0.6 - 0.1, -1.2, entry._raise * 0.6);
        a.head.rotation.z = Math.sin(t * 3) * 0.3 * entry._daze;
        a.head.rotation.x = 0.25 * entry._daze + breath * 0.03;
        a.jaw.rotation.x = Math.max(0, Math.sin(t * (p2 ? 9 : 5) + ph)) * 0.3 + 0.35 * entry._raise;
        if (a.cape) a.cape.rotation.x = 0.12 + 0.35 * m + Math.sin(t * 1.4) * 0.05;
        const flick = p2 ? 0.7 + 0.3 * Math.sin(t * 17) * Math.sin(t * 7) : 0.85 + 0.15 * Math.sin(t * 3);
        a.soul.scale.setScalar((p2 ? 0.26 : 0.2) * flick);
        const fade = entry._fade ?? 1;
        a.soulGlow.material.opacity = 0.55 * flick * fade;
        a.soulGlow.scale.setScalar((p2 ? 0.85 : 0.6) * flick);
        for (const g of a.eyeGlows) g.material.opacity = (0.6 + 0.3 * flick) * fade;
        if (p2 && !entry._p2) {
          entry._p2 = true;
          const hot = 0xff5ad8;
          a.eyeMat.userData.baseEmissive.setHex(hot);
          a.soulMat.userData.baseEmissive.setHex(hot);
          a.soulGlow.material.color.setHex(hot);
          for (const g of a.eyeGlows) g.material.color.setHex(hot);
        }
        root.position.y = Math.abs(Math.sin(ph * 1.1)) * 0.04 * m + (entry._hopArcY || 0);
        break;
      }
      default:
        root.position.y = Math.sin(ph * 0.8) * 0.02;
    }
    if (a.eliteGem) {
      a.eliteGem.rotation.y += dt * 2.2;
      a.eliteGem.position.y = a.eliteGemY + Math.sin(t * 2.5 + ph) * 0.04;
    }
  }

  // ================================================================== MERCHANT
  buildMerchant() {
    const materials = [];
    const extraMats = [];
    const root = new THREE.Group();
    const mat = this.vmat(materials, { roughness: 0.75 });
    const metal = this.vmat(materials, { roughness: 0.3, metalness: 0.55 });
    const rugMat = this.vmat(materials, { roughness: 0.95 });
    const lanternMat = this.mat(0xffe08a, { emissive: 0xffaa33, emissiveIntensity: 1.4 }, materials);
    const coinMat = this.mat(0xffd23f, { emissive: 0xb07800, emissiveIntensity: 0.6, metalness: 0.4, roughness: 0.3 }, materials);
    const COAT = 0x2e9a86, COAT_D = 0x1f6e60, SHIRT = 0xf4ead0, SKIN = 0xf3c49c, HAT = 0x7a4a26, HAT_D = 0x5a331a,
      BAND = 0xe8423f, LEATHER = 0x8a5a34, LEATHER_D = 0x5e3b20, GOLD = 0xf0c040, STACHE = 0x7a5a3a;

    // Rug with the wares laid out in front.
    this.mesh('mc_rug', [
      P('lootDisc', 0x9a2f4a, [0.74, 1, 0.74], [0, 0.012, 0.02]),
      P('lootRing', GOLD, [0.66, 1, 0.66], [0, 0.016, 0.02]),
    ], rugMat, root);
    this.mesh('mc_wares', [
      // Potions (health red, mana blue) with corks.
      P('sphereLow', 0xe23a3a, 0.1, [-0.2, 0.06, 0.24]),
      P('cylinder', 0xdff4ff, [0.04, 0.06, 0.04], [-0.2, 0.13, 0.24]),
      P('cylinder', 0x8a6a3a, [0.045, 0.03, 0.045], [-0.2, 0.17, 0.24]),
      P('sphereLow', 0x3aa0ff, 0.09, [-0.08, 0.055, 0.31]),
      P('cylinder', 0xdff4ff, [0.04, 0.05, 0.04], [-0.08, 0.12, 0.31]),
      P('cylinder', 0x8a6a3a, [0.045, 0.03, 0.045], [-0.08, 0.155, 0.31]),
      // Little treasure chest.
      P('box', LEATHER, [0.16, 0.09, 0.11], [0.2, 0.06, 0.26]),
      P('cylinder', LEATHER_D, [0.11, 0.16, 0.11], [0.2, 0.105, 0.26], [0, 0, Math.PI / 2]),
      P('box', GOLD, [0.03, 0.05, 0.02], [0.2, 0.08, 0.32]),
    ], mat, root);

    const body = this.pivot(root, 0, 0, -0.02);
    this.mesh('mc_body', [
      P('robe', COAT, [0.5, 0.44, 0.46], [0, 0.23, 0]),
      P('sphere', COAT, [0.42, 0.4, 0.38], [0, 0.46, 0]),
      P('sphere', SHIRT, [0.24, 0.3, 0.12], [0, 0.46, 0.13]),
      P('cylinder', LEATHER_D, [0.44, 0.05, 0.4], [0, 0.36, 0]),
      P('box', GOLD, [0.06, 0.05, 0.03], [0, 0.36, 0.2]),
      P('sphere', LEATHER, [0.1, 0.12, 0.08], [0.16, 0.3, 0.14]),
      P('cylinder', COAT_D, [0.5, 0.04, 0.46], [0, 0.04, 0]),
      P('cylinder', SKIN, [0.1, 0.06, 0.1], [0, 0.66, 0]),
    ], mat, body);
    // Overstuffed backpack with a bedroll, a pot, a shield and a sword poking out.
    this.mesh('mc_pack', [
      P('box', LEATHER, [0.38, 0.4, 0.22], [0, 0.5, -0.24]),
      P('box', LEATHER_D, [0.3, 0.14, 0.05], [0, 0.44, -0.36]),
      P('cylinder', BAND, [0.15, 0.44, 0.15], [0, 0.76, -0.24], [0, 0, Math.PI / 2]),
      P('cylinder', SHIRT, [0.155, 0.08, 0.155], [0.12, 0.76, -0.24], [0, 0, Math.PI / 2]),
      P('cylinder', SHIRT, [0.155, 0.08, 0.155], [-0.12, 0.76, -0.24], [0, 0, Math.PI / 2]),
      P('box', 0xb58a52, [0.16, 0.14, 0.14], [0.08, 0.9, -0.24], [0, 0.3, 0]),
      P('dome', 0x5a5f6e, [0.16, 0.1, 0.16], [-0.25, 0.44, -0.24], [0, 0, Math.PI / 2]),
    ], mat, body);
    this.mesh('mc_gear', [
      P('cylinder', 0xa9b2c2, [0.28, 0.04, 0.28], [0, 0.52, -0.37], [Math.PI / 2, 0, 0]),
      P('sphereLow', GOLD, [0.08, 0.08, 0.04], [0, 0.52, -0.39]),
      P('box', 0xe6ebf2, [0.04, 0.34, 0.015], [-0.13, 0.95, -0.2], [0, 0, 0.2]),
      P('box', GOLD, [0.12, 0.03, 0.04], [-0.1, 0.78, -0.2], [0, 0, 0.2]),
      P('cylinder', HAT_D, [0.025, 0.5, 0.025], [0.2, 0.8, -0.3]),
      P('cylinder', HAT_D, [0.02, 0.16, 0.02], [0.26, 1.04, -0.3], [0, 0, Math.PI / 2]),
    ], metal, body);
    // Lantern swinging from the pack pole.
    const lanternPivot = this.pivot(body, 0.33, 1.04, -0.3);
    this.mesh('mc_lantern_frame', [
      P('cylinder', 0x3a3a44, [0.012, 0.08, 0.012], [0, -0.04, 0]),
      P('cone', 0x3a3a44, [0.1, 0.05, 0.1], [0, -0.09, 0]),
      P('cylinder', 0x3a3a44, [0.1, 0.02, 0.1], [0, -0.21, 0]),
    ], metal, lanternPivot);
    this.single('sphereLow', lanternMat, lanternPivot, [0.12, 0.13, 0.12], [0, -0.15, 0]);
    const lanternGlow = this.glow(0xffaa33, 0.7, 0.55, extraMats, lanternPivot, [0, -0.15, 0]);

    // Head, bushy moustache and a wide-brimmed feathered hat.
    const head = this.pivot(body, 0, 0.8, 0.02);
    this.mesh('mc_head', [
      P('sphere', SKIN, [0.3, 0.29, 0.29], [0, 0, 0]),
      P('sphereLow', 0x2b2233, [0.04, 0.055, 0.03], [0.055, 0.02, 0.135]),
      P('sphereLow', 0x2b2233, [0.04, 0.055, 0.03], [-0.055, 0.02, 0.135]),
      P('sphere', 0xf0a888, [0.08, 0.07, 0.07], [0, -0.02, 0.15]),
      P('sphere', STACHE, [0.12, 0.05, 0.06], [0.05, -0.065, 0.14], [0, 0, -0.3]),
      P('sphere', STACHE, [0.12, 0.05, 0.06], [-0.05, -0.065, 0.14], [0, 0, 0.3]),
      P('cylinder', HAT, [0.46, 0.03, 0.46], [0, 0.11, -0.02]),
      P('frustum', HAT, [0.28, 0.16, 0.28], [0, 0.19, 0]),
      P('cylinder', BAND, [0.29, 0.045, 0.29], [0, 0.14, 0]),
      P('cone', 0x7ad14a, [0.05, 0.26, 0.03], [0.12, 0.26, -0.06], [-0.5, 0, -0.5]),
      P('cone', 0xffd23f, [0.03, 0.18, 0.02], [0.1, 0.24, -0.05], [-0.4, 0, -0.7]),
    ], mat, head);
    // Arms: left one waves at a nearby player; right rests on the coin pouch.
    const armParts = [P('capsule', COAT, [0.1, 0.08, 0.1], [0, -0.09, 0]), P('cylinder', SHIRT, [0.1, 0.03, 0.1], [0, -0.17, 0]), P('sphereLow', SKIN, 0.09, [0, -0.21, 0])];
    const armL = this.pivot(body, 0.21, 0.58, 0, 'YXZ');
    const armR = this.pivot(body, -0.21, 0.58, 0, 'YXZ');
    this.mesh('mc_arm', armParts, mat, armL);
    this.mesh('mc_arm', armParts, mat, armR);
    armL.rotation.set(-0.3, 0, 0.3);
    armR.rotation.set(-0.5, 0, -0.35);

    // Bobbing, spinning gold coin: the "shop" marker.
    const coinPivot = this.pivot(root, 0, 1.55, 0);
    this.single('cylinder', coinMat, coinPivot, [0.16, 0.03, 0.16], null, [Math.PI / 2, 0, 0]);
    const coinGlow = this.glow(0xffd23f, 0.55, 0.4, extraMats, coinPivot, [0, 0, 0]);

    root.add(this.r._makeBlobShadow(0.8));
    return { root, materials, extraMats, body, head, armL, armR, lanternPivot, lanternGlow, coinPivot, coinGlow, phase: Math.random() * Math.PI * 2 };
  }

  animateMerchant(entry, npc, player, dt) {
    entry.phase += dt;
    const t = entry.phase;
    const px = player ? (player.fx ?? player.x) : npc.x, py = player ? (player.fy ?? player.y) : npc.y;
    const d = Math.hypot(px - npc.x, py - npc.y);
    const near = !!player && !player.dead && d < 3.2;
    entry._near = lerp(entry._near || 0, near ? 1 : 0, Math.min(1, dt * 4));
    const n = entry._near;
    // Turn toward a nearby player, otherwise face the camera.
    const target = near ? Math.atan2(px - npc.x, py - npc.y) : 0;
    let diff = target - entry.body.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    entry.body.rotation.y += diff * Math.min(1, dt * 3);
    entry.body.rotation.z = Math.sin(t * 1.2) * 0.035;
    entry.body.position.y = Math.abs(Math.sin(t * 1.2)) * 0.01;
    entry.head.rotation.x = Math.sin(t * 0.9) * 0.05;
    entry.lanternPivot.rotation.z = Math.sin(t * 1.9) * 0.25;
    entry.lanternPivot.rotation.x = Math.sin(t * 1.3 + 1) * 0.12;
    // Wave: a cheery burst when the player first comes close, then every few seconds.
    if (near && !entry._wasNear) entry._waveT = 1.6;
    entry._wasNear = near;
    entry._waveCd = (entry._waveCd || 0) - dt;
    if (near && entry._waveCd <= 0 && !(entry._waveT > 0)) { entry._waveT = 1.4; entry._waveCd = 5; }
    let wave = 0;
    if (entry._waveT > 0) {
      entry._waveT = Math.max(0, entry._waveT - dt);
      const k = entry._waveT;
      wave = Math.min(1, k * 4, (1.6 - k) * 6);
    }
    entry._wave = lerp(entry._wave || 0, wave, Math.min(1, dt * 10));
    const w = entry._wave;
    entry.armL.rotation.set(lerp(-0.3, -0.2, w), 0, lerp(0.3, 2.6 + Math.sin(t * 12) * 0.35, w));
    entry.armR.rotation.set(-0.5 + Math.sin(t * 1.2) * 0.05, 0, -0.35);
    entry.coinPivot.position.y = 1.55 + Math.sin(t * 1.8) * 0.05;
    entry.coinPivot.rotation.y += dt * 1.6;
    entry.lanternGlow.material.opacity = 0.5 + 0.15 * Math.sin(t * 4) + 0.1 * n;
  }
}
