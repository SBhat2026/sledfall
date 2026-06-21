// Penguin rider: loads the user's rigged penguin model (GLB) and paints it
// with procedural vertex colors (no texture in the source file). Falls back
// to a primitive-built penguin if the model fails to load.
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/jsm/loaders/GLTFLoader.js';

// ---- vertex painting -------------------------------------------------------
// model space: y up (0..1.2), beak faces +z, T-pose flippers along ±x.
// Styled after the reference penguin images: near-black cap/back/flippers,
// huge white belly that wraps around the sides, white face around the eyes
// with a black widow's-peak wedge between them, orange beak + webbed feet.
const COL = {
  back: new THREE.Color(0x1a1e25),    // near-black back/head/flippers
  belly: new THREE.Color(0xf6f7f8),   // white front
  beak: new THREE.Color(0xf09a30),    // orange
  feet: new THREE.Color(0xee8f2c),
};
function paintPenguin(geo) {
  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  const clamp = THREE.MathUtils.clamp;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y < 0.045 && z > -0.14) {
      c.copy(COL.feet);                                  // webbed feet
    } else if (y > 0.84 && y < 1.1 && z > 0.17 && Math.abs(x) < 0.1) {
      c.copy(COL.beak);                                  // beak (narrow snout only)
    } else {
      let w = 0; // white amount
      if (y < 0.9) {
        // belly: very wide, wraps toward the sides, soft edges
        w = clamp(Math.min(
          (0.42 - Math.abs(x)) / 0.09,
          (z + 0.02) / 0.09,
          (y - 0.02) / 0.05), 0, 1);
      } else if (y < 1.16) {
        // face: white cheeks surrounding the eyes…
        const face = Math.min((z - 0.04) / 0.07, (1.14 - y) / 0.05 + 1);
        // …split by a black widow's-peak wedge, narrow at the beak,
        // widening up into the cap
        const wedge = (Math.abs(x) - (0.022 + Math.max(0, y - 0.96) * 0.45)) / 0.035;
        w = clamp(Math.min(face, wedge), 0, 1);
      }
      c.copy(COL.back).lerp(COL.belly, w);
    }
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// ---- rig --------------------------------------------------------------------
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// selectable riders. Both are Madagascar-penguin rigs (same core skeleton +
// a baked walk clip). Skipper ships no texture so its colours are painted from
// geometry; Kowalski's colours are baked into the GLB's vertex colours.
export const CHARACTERS = {
  skipper:  { name: 'Skipper',  url: '/assets/penguin.glb',  paint: true },
  kowalski: { name: 'Kowalski', url: '/assets/kowalski.glb', paint: false },
};
export const CHARACTER_IDS = ['skipper', 'kowalski'];

export class PenguinRig {
  constructor() {
    this.group = new THREE.Group();
    this.bones = {};
    this.rest = {};
    this.restPos = {};
    this.ready = false;
    this.mixer = null;
    this.walkAction = null;
    this.charId = 'skipper';
    this._buildFallback();
  }

  // back-compat shim
  load(url) {
    const id = Object.keys(CHARACTERS).find(k => CHARACTERS[k].url === url) || 'skipper';
    return this.loadCharacter(id);
  }

  async loadCharacter(id) {
    const cfg = CHARACTERS[id] || CHARACTERS.skipper;
    this.charId = id in CHARACTERS ? id : 'skipper';
    try {
      const gltf = await new GLTFLoader().loadAsync(cfg.url);
      const model = gltf.scene;
      let mesh = null;
      model.traverse(o => { if (o.isSkinnedMesh) mesh = o; });
      if (!mesh) throw new Error('no skinned mesh');

      if (cfg.paint) paintPenguin(mesh.geometry); // Skipper: no texture/colours
      mesh.material = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.72, metalness: 0,
      });
      mesh.frustumCulled = false; // skinned bounds drift when posed

      model.updateMatrixWorld(true);
      // the rig names bones with dots (UpperArm.L, UpperLeg.R…); also expose a
      // dot-free alias (UpperArmL) so the pose code below addresses them — the
      // limbs were silently never posing before this aliasing was added
      this.bones = {};
      model.traverse(o => {
        if (!o.isBone) return;
        this.bones[o.name] = o;
        const alias = o.name.replace(/\./g, '');
        if (alias !== o.name && !this.bones[alias]) this.bones[alias] = o;
      });
      // store rest local rotation + position + bind-pose parent world rotation
      // so we can pose bones about model-space axes regardless of bone roll
      this.rest = {}; this.restPos = {}; this.parentWorld = {};
      for (const [name, b] of Object.entries(this.bones)) {
        this.rest[name] = b.quaternion.clone();
        this.restPos[name] = b.position.clone();
        this.parentWorld[name] = b.parent.getWorldQuaternion(new THREE.Quaternion());
      }

      this._placeEyes(mesh);

      // baked walk animation → AnimationMixer (advanced only while walking)
      this.mixer = null; this.walkAction = null;
      if (gltf.animations && gltf.animations.length) {
        this.mixer = new THREE.AnimationMixer(model);
        const clip = gltf.animations.find(c => /walk/i.test(c.name)) || gltf.animations[0];
        this.walkAction = this.mixer.clipAction(clip);
        this.walkAction.play();
        this.mixer.update(0);
      }

      model.scale.setScalar(0.78); // ~0.95 m tall — fits the saucer
      if (this.model) this.group.remove(this.model);
      if (this.fallback) this.group.remove(this.fallback);
      this.group.add(model);
      this.model = model;
      this.ready = true;
    } catch (err) {
      console.warn('character model failed, using fallback:', err);
    }
  }

  // jet-black bead eyes, placed from the actual head geometry so they sit on
  // the face for either rig: find the head-bone-weighted verts, take a spot
  // just above the head centre, and seat the bead on the face surface there.
  _placeEyes(mesh) {
    const head = this.bones.Head;
    if (!head) return;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const bones = mesh.skeleton ? mesh.skeleton.bones : [];
    const headIdx = bones.findIndex(b => b.name === 'Head');
    const pts = [];
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      if (si && sw && headIdx >= 0) {
        if (si.getX(i) === headIdx) w += sw.getX(i);
        if (si.getY(i) === headIdx) w += sw.getY(i);
        if (si.getZ(i) === headIdx) w += sw.getZ(i);
        if (si.getW(i) === headIdx) w += sw.getW(i);
      }
      if (w > 0.5) pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
    if (pts.length < 20) { // fallback: upper third of the whole mesh
      pts.length = 0;
      let top = -1e9;
      for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
      for (let i = 0; i < pos.count; i++)
        if (pos.getY(i) > top * 0.72) pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
    let cx = 0, cy = 0, minY = 1e9, maxY = -1e9, maxX = 0;
    for (const p of pts) {
      cx += p.x; cy += p.y;
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); maxX = Math.max(maxX, Math.abs(p.x));
    }
    cx /= pts.length; cy /= pts.length;
    const eyeY = cy + (maxY - cy) * 0.35;
    const eyeX = Math.max(0.03, maxX * 0.46);
    const band = Math.max(0.05, (maxY - minY) * 0.2);
    const r = Math.max(0.022, (maxY - minY) * 0.07);
    // find the actual face surface (front-most z) at THIS eye's spot, per side,
    // so the bead seats on the face for either rig instead of on a global max
    const frontAt = (side) => {
      let fz = -1e9;
      for (const p of pts) {
        const sx = p.x * side;
        if (sx > eyeX * 0.35 && sx < eyeX * 2.1 && Math.abs(p.y - eyeY) < band)
          if (p.z > fz) fz = p.z;
      }
      return fz > -1e8 ? fz : 0.1;
    };
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.18, metalness: 0.05 });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 14), eyeMat);
      eye.scale.set(1, 1.15, 0.78);
      // embed the bead INTO the face: push its centre behind the surface so
      // only the front cap pokes out (a black bead set in the head, not a ball
      // floating off the front). depth scale 0.78 → ~0.39r of cap shows.
      const fz = frontAt(side);
      const pt = new THREE.Vector3(side * eyeX, eyeY, fz - r * 0.6);
      head.worldToLocal(pt);
      eye.position.copy(pt);
      head.add(eye);
    }
  }

  // primitive penguin shown until (or in case) the GLB arrives
  _buildFallback() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 16),
      new THREE.MeshStandardMaterial({ color: COL.back, roughness: 0.8 }));
    body.scale.set(1, 1.25, 0.9); body.position.y = 0.45;
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 16),
      new THREE.MeshStandardMaterial({ color: COL.belly, roughness: 0.8 }));
    belly.scale.set(0.82, 1.1, 0.62); belly.position.set(0, 0.42, 0.1);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 10),
      new THREE.MeshStandardMaterial({ color: COL.beak, roughness: 0.6 }));
    beak.rotation.x = Math.PI / 2; beak.position.set(0, 0.78, 0.33);
    g.add(body, belly, beak);
    this.fallback = g;
    this.group.add(g);
  }

  // reset a bone, then rotate it about MODEL-space axes (handles arbitrary
  // bone roll): local = inv(parentWorld) · Q_world · parentWorld · rest
  _setW(name, ax, ay, az) {
    const b = this.bones[name];
    if (!b) return;
    const pw = this.parentWorld[name];
    b.quaternion.copy(this.rest[name]);
    const apply = (axis, angle) => {
      if (!angle) return;
      _q.setFromAxisAngle(axis, angle);
      _q2.copy(pw).invert().multiply(_q).multiply(pw);
      b.quaternion.premultiply(_q2);
    };
    apply(AXIS_X, ax);
    apply(AXIS_Y, ay);
    apply(AXIS_Z, az);
  }

  // undo any bone translation the walk clip left behind (mixer drives position
  // on the hips); rotations get reset per-bone by _setW
  _restPositions() {
    if (!this.mixer) return;
    for (const name in this.bones) {
      const rp = this.restPos[name];
      if (rp) this.bones[name].position.copy(rp);
    }
  }

  // seated on the saucer: legs out front, flippers gripping, lean to steer
  poseSit(lean, speedT = 0, t = 0) {
    if (!this.ready) { this.group.rotation.set(0.1, 0, -lean * 0.3); return; }
    this.group.rotation.set(0, 0, 0);
    this._restPositions();
    this._setW('Spine', 0.12 + speedT * 0.2, 0, -lean * 0.35);
    this._setW('Chest', 0.06, 0, -lean * 0.12);
    this._setW('Head', -0.15 - speedT * 0.15, lean * 0.25, 0);
    // flippers: swing down AND forward to grip the rim, held clear of the body
    // (a little out on the +z/-z so they don't sink into the round belly)
    this._setW('UpperArmL', 0.55, -0.35, -0.92 + lean * 0.2);
    this._setW('UpperArmR', 0.55, 0.35, 0.92 + lean * 0.2);
    // legs: thighs swing forward over the rim, knees together, feet up
    this._setW('UpperLegL', 1.3, 0.18, 0);
    this._setW('UpperLegR', 1.3, -0.18, 0);
    this._setW('LowerLegL', -0.35, -0.1, 0);
    this._setW('LowerLegR', -0.35, 0.1, 0);
    // chatter bob
    this.group.position.y = Math.sin(t * 23) * 0.012 * speedT;
  }

  // belly slide: penguin flat on its front, head + chest arched up to look
  // ahead, flippers swept out like little skis, legs trailing straight back.
  poseBelly(lean, speedT = 0, t = 0) {
    if (!this.ready) { this.group.rotation.set(1.45, 0, -lean * 0.2); return; }
    this.group.rotation.set(1.42, 0, 0); // tip prone, head end up a touch
    this._restPositions();
    this._setW('Spine', -0.3, 0, -lean * 0.22);
    this._setW('Chest', -0.2, 0, -lean * 0.1);
    this._setW('Head', -0.5 - speedT * 0.1, lean * 0.3, 0);   // chin up, scanning the hill
    this._setW('UpperArmL', 0, -0.2, -1.32 + lean * 0.25);     // flippers fanned back
    this._setW('UpperArmR', 0, 0.2, 1.32 + lean * 0.25);
    this._setW('UpperLegL', -0.18, 0.12, 0);                   // legs streamlined back
    this._setW('UpperLegR', -0.18, -0.12, 0);
    this._setW('LowerLegL', 0.15, 0, 0);
    this._setW('LowerLegR', 0.15, 0, 0);
    this.group.position.y = Math.sin(t * 28) * 0.008 * speedT; // little chatter
  }

  // walking: play the baked walk clip via the mixer (advanced only while
  // moving; frozen at frame 0 when idle). falls back to a procedural waddle if
  // the model has no clip / hasn't loaded.
  poseWalk(dt, moving, speedScale = 1) {
    if (!this.ready) {
      this.group.rotation.set(0, 0, moving ? Math.sin(performance.now() * 0.012) * 0.12 : 0);
      return;
    }
    this.group.rotation.set(0, 0, 0);
    this.group.position.y = 0;
    if (this.mixer && this.walkAction) {
      if (moving) {
        this.mixer.update(dt * 1.5 * speedScale);
        const h = this.bones.Hips;                    // keep the walk in place
        if (h && this.restPos.Hips) { h.position.x = this.restPos.Hips.x; h.position.z = this.restPos.Hips.z; }
      } else {
        this.walkAction.time = 0;
        this.mixer.update(0);
      }
      return;
    }
    // procedural waddle fallback
    this.walkCycle = (this.walkCycle || 0) + (moving ? dt * 9 * speedScale : 0);
    const c = this.walkCycle;
    const s = moving ? Math.sin(c) : 0;
    const rock = moving ? Math.sin(c) * 0.14 : 0;
    this.group.position.y = moving ? Math.abs(Math.cos(c)) * 0.03 : 0;
    this._setW('Hips', 0, 0, rock);
    this._setW('Spine', moving ? 0.06 : 0, 0, -rock * 0.5);
    this._setW('Head', 0, 0, -rock * 0.4);
    this._setW('UpperArmL', s * 0.2, 0, -0.5);
    this._setW('UpperArmR', -s * 0.2, 0, 0.5);
    this._setW('UpperLegL', Math.max(0, s) * 0.6, 0, 0);
    this._setW('UpperLegR', Math.max(0, -s) * 0.6, 0, 0);
  }

  // tumbling: flippers and feet windmilling, settling limp as amp dies
  poseFlail(t, amp = 1) {
    const a = Math.max(0.12, Math.min(1, amp));
    if (!this.ready) { this.group.rotation.set(Math.sin(t * 9) * a, 0, Math.cos(t * 7) * a); return; }
    this.group.rotation.set(0, 0, 0);
    this.group.position.y = 0;
    this._restPositions();
    this._setW('Spine', Math.sin(t * 9) * 0.4 * a, 0, Math.cos(t * 7) * 0.3 * a);
    this._setW('Head', Math.sin(t * 11) * 0.5 * a, Math.cos(t * 8) * 0.3 * a, 0);
    this._setW('UpperArmL', Math.sin(t * 13) * 1.2 * a, 0, -0.4 - Math.cos(t * 10) * 0.9 * a);
    this._setW('UpperArmR', Math.cos(t * 12) * 1.2 * a, 0, 0.4 + Math.sin(t * 11) * 0.9 * a);
    this._setW('UpperLegL', Math.sin(t * 10) * 1.1 * a + 0.3, 0, 0.25 * a);
    this._setW('UpperLegR', Math.cos(t * 11) * 1.1 * a + 0.3, 0, -0.25 * a);
  }
}

// ---- sleds ------------------------------------------------------------------
// the user's inner-tube sled model (GLB), tinted per shop style; a procedural
// saucer fills in until the model arrives (or if it fails to load)
let sledProto = null;
let sledPromise = null;
function loadSledModel() {
  if (!sledPromise) {
    sledPromise = new GLTFLoader().loadAsync('/assets/Sled1.glb').then(gltf => {
      let mesh = null;
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(o => { if (o.isMesh && !mesh) mesh = o; });
      if (!mesh) return null;
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
      const dia = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
      sledProto = { geo, s: 1.36 / dia };
      return sledProto;
    }).catch(err => { console.warn('sled model failed, keeping saucer:', err); return null; });
  }
  return sledPromise;
}

const SLED_STYLES = {
  classic: { disc: 0x2f6fd6, handle: 0x1d4fa8, accent: 0x4f8ce6 },
  crimson: { disc: 0xd6452f, handle: 0x8c1f14, accent: 0xf5f0e6 },
  ice:     { disc: 0xaadcf5, handle: 0xd8f2ff, accent: 0xffffff, translucent: true },
  carbon:  { disc: 0x2c333c, handle: 0x32d6c3, accent: 0x32d6c3 },
  royal:   { disc: 0xe6bb45, handle: 0x8c1f2f, accent: 0xc99a25, gold: true },
};

export function createSled(style = 'classic') {
  const S = SLED_STYLES[style] || SLED_STYLES.classic;
  const g = new THREE.Group();
  const matOpts = S.translucent ? { transparent: true, opacity: 0.85 } : {};
  const discMat = new THREE.MeshStandardMaterial({
    color: S.disc, roughness: S.gold ? 0.25 : 0.35, metalness: S.gold ? 0.85 : 0.05, ...matOpts,
  });
  const handleMat = new THREE.MeshStandardMaterial({
    color: S.handle, roughness: 0.4, metalness: S.gold ? 0.7 : 0.1,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: S.accent, roughness: 0.4, metalness: S.gold ? 0.7 : 0.05, ...matOpts,
  });

  // smooth dished disc with a rounded rolled rim
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.42, 0.1, 36), discMat);
  disc.position.y = 0.07;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.055, 12, 36), accentMat);
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.14;
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.035, 28), accentMat);
  seat.position.y = 0.125;
  g.add(disc, rim, seat);
  // rounded grab handles
  for (const side of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.028, 10, 18, Math.PI), handleMat);
    grip.position.set(side * 0.48, 0.17, -0.15);
    grip.rotation.y = Math.PI / 2;
    g.add(grip);
  }

  // swap in the real tube model once it's loaded
  loadSledModel().then(m => {
    if (!m) return;
    g.clear();
    const tube = new THREE.Mesh(m.geo, discMat);
    tube.scale.set(m.s, m.s * 0.62, m.s); // squash: saucer-flat, rider fits the hole
    g.add(tube);
  });
  return g;
}
