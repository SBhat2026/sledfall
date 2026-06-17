// Player: custom momentum physics — slope-driven acceleration, lateral grip,
// carve/drift, airtime + tricks, tumble crashes, walk mode.
import * as THREE from 'three';
import { SPAWN, SPAWN_HEADING, surfaceAt } from './terrain.js';
import { PenguinRig, createSled, CHARACTERS } from './character.js';

const G = 11.5;                 // exaggerated gravity (arcade) — constant everywhere
const DRAG_K = 0.0036;          // quadratic drag → terminal ≈ 36 m/s
const GRIP = 7.5;               // lateral damping /s (carving)
const CARVE = 4.5;              // velocity-redirect toward heading /s
const BRAKE = 7.0;
const PADDLE = 6.5;             // push accel at low speed
const TUCK_DRAG = 0.55;         // drag multiplier while tucking (hold W at speed)
const LAUNCH_VN = 1.8;          // rise (m/s) above the slope ahead that detaches us → jump
const CLIFF_GAP = 0.5;          // step off an overhang/cliff this far → airborne regardless
const CRASH_LAND_VN = 26;       // downward impact speed that ends you (designed jumps land ≈17–21)
const CRASH_TILT = 1.35;        // rad of leftover flip rotation tolerated on landing
const POP_MAX = 0.12;           // max momentum bonus off a lip (subtle, but still pops)
const LAND_RECOVER = 0.5;       // fraction of landing impact returned on slope-matched landings
const WALK_SPEED = 4.4;
const SPRINT_MULT = 2.0;        // Shift while walking → sprint
const BODY_CLEAR = 0.05;        // sit the sled this far proud of the surface
const BELLY_CLEAR = 0.02;       // belly-slide hugs the snow closer than the sled
const MAX_SPEED = 36;           // hard top speed — riding a cliff stays fast, not silly

const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class Player {
  constructor(scene, terrain, input, hud, audio) {
    this.scene = scene;
    this.terrain = terrain;
    this.input = input;
    this.hud = hud;
    this.audio = audio;

    this.pos = new THREE.Vector3(SPAWN.x, 0, SPAWN.z);
    this.stats = { drag: 1, grip: 1, steer: 1, flip: 1 }; // overridden by equipped sled
    this.onScore = null;
    this.vel = new THREE.Vector3();
    this.heading = 0;             // yaw, 0 = facing +z (downhill)
    this.state = 'sled';          // sled | belly | air | walk | crash
    this.groundMode = 'sled';     // what we return to on landing: sled | belly
    this.grounded = true;
    this.lean = 0;
    this.time = 0;
    this.score = 0;

    // air trick tracking
    this.airPitch = 0;            // accumulated flip
    this.airSpin = 0;             // accumulated spin
    this.airTime = 0;
    this.landedImpact = 0;        // set on touchdown, consumed by camera shake
    this.prevPos = new THREE.Vector3();

    // crash bodies
    this.crashTimer = 0;
    this.bodyVel = new THREE.Vector3();
    this.bodySpin = new THREE.Vector3();
    this.sledVel = new THREE.Vector3();
    this.sledSpin = new THREE.Vector3();
    this.sledPos = new THREE.Vector3();

    // visuals
    this.root = new THREE.Group();          // oriented to terrain + heading
    this.sled = createSled();
    this.rig = new PenguinRig();
    let saved = 'skipper';
    try { saved = localStorage.getItem('sledfall-char') || 'skipper'; } catch { /* no storage */ }
    this.characterId = saved in CHARACTERS ? saved : 'skipper';
    this.rig.loadCharacter(this.characterId); // async; fallback shows meanwhile
    this.rigMount = new THREE.Group();    // pose offset lives here, bob lives on rig.group
    this.rigMount.add(this.rig.group);
    this.rigMount.position.set(0, 0.14, 0.05);
    this.root.add(this.sled, this.rigMount);
    scene.add(this.root);

    this.sledDetached = createSled();       // used during crashes
    this.sledDetached.visible = false;
    scene.add(this.sledDetached);

    // blob shadow
    const shGeo = new THREE.CircleGeometry(0.72, 24);
    const shMat = new THREE.MeshBasicMaterial({ color: 0x223349, transparent: true, opacity: 0.2, depthWrite: false });
    this.shadow = new THREE.Mesh(shGeo, shMat);
    scene.add(this.shadow);

    this.smoothNormal = new THREE.Vector3(0, 1, 0);
    this.visQuat = new THREE.Quaternion();
    this.walkCycle = 0;

    this.respawn(true, true); // start on foot at the lodge, hike up, then sled down
  }

  // swap in a sled from the shop: stats + meshes (riding and crash copies)
  setSled(def) {
    this.stats = def.stats;
    const fresh = createSled(def.id);
    fresh.position.copy(this.sled.position);
    this.root.remove(this.sled);
    this.root.add(fresh);
    fresh.visible = this.sled.visible;
    this.sled = fresh;

    const freshDetached = createSled(def.id);
    freshDetached.position.copy(this.sledDetached.position);
    freshDetached.visible = this.sledDetached.visible;
    this.scene.remove(this.sledDetached);
    this.scene.add(freshDetached);
    this.sledDetached = freshDetached;
  }

  // swap the rider model (Skipper ⇄ Kowalski); persists across sessions
  setCharacter(id) {
    if (!(id in CHARACTERS)) return;
    this.characterId = id;
    this.rig.loadCharacter(id);
    try { localStorage.setItem('sledfall-char', id); } catch { /* no storage */ }
  }

  respawn(toSummit = false, walking = false) {
    if (toSummit) {
      // user-set respawn point wins; the spawn peak is the default
      const rp = this.respawnPoint;
      this.pos.set(rp ? rp.x : SPAWN.x, 0, rp ? rp.z : SPAWN.z);
    }
    this.pos.y = this.terrain.height(this.pos.x, this.pos.z) + 0.2;
    this.vel.set(0, 0, 0);
    if (walking) {
      this.heading = Math.PI;   // face uphill — hike up from the lodge, then sled down
    } else if (toSummit) {
      this.heading = this.respawnPoint ? this.respawnPoint.heading : SPAWN_HEADING;
    } else {
      // face the local downhill so a reset always points somewhere useful
      const n = this.terrain.normal(this.pos.x, this.pos.z, _n);
      this.heading = (Math.abs(n.x) + Math.abs(n.z)) > 0.02 ? Math.atan2(n.x, n.z) : this.heading;
    }
    this.state = walking ? 'walk' : 'sled';
    this.groundMode = 'sled';
    this.moving = false;
    this.grounded = true;
    this.airPitch = this.airSpin = this.airTime = 0;
    this.sledDetached.visible = false;
    this.sled.visible = true;
    this.smoothNormal.set(0, 1, 0);
  }

  headingDir(out = _f) {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  speed() { return this.vel.length(); }
  planarSpeed() { return Math.hypot(this.vel.x, this.vel.z); }

  update(dt) {
    this.time += dt;
    const inp = this.input;

    if (inp.consume('KeyR')) {
      // set a respawn point right here — T brings you back to it
      this.respawnPoint = { x: this.pos.x, z: this.pos.z, heading: this.heading };
      this.hud.trick('RESPAWN SET', 0);
    }
    if (inp.consume('KeyT')) {
      this.hud.fadeLift(() => this.respawn(true)); // teleport to the respawn point
      return;
    }
    const canSwitch = this.grounded && this.planarSpeed() < 7 &&
      (this.state === 'sled' || this.state === 'walk' || this.state === 'belly');
    if (inp.consume('KeyE') && canSwitch) {
      // E: toggle between the sled and on-foot
      this.state = this.state === 'walk' ? 'sled' : 'walk';
      if (this.state === 'sled') { this.groundMode = 'sled'; this.vel.multiplyScalar(0.3); }
    }
    if (inp.consume('KeyB') && this.grounded && this.planarSpeed() < 7 &&
        (this.state === 'sled' || this.state === 'walk' || this.state === 'belly')) {
      // B: flop onto the belly to slide, or stand back up
      if (this.state === 'belly') {
        this.state = 'walk';
      } else {
        this.state = 'belly'; this.groundMode = 'belly'; this.vel.multiplyScalar(0.5);
      }
    }

    switch (this.state) {
      case 'sled':
      case 'belly': this._updateSled(dt); break;
      case 'air': this._updateAir(dt); break;
      case 'walk': this._updateWalk(dt); break;
      case 'crash': this._updateCrash(dt); break;
    }

    this._updateVisuals(dt);
  }

  // ---- sledding on the ground -------------------------------------------
  _updateSled(dt) {
    const inp = this.input;
    const t = this.terrain;
    this.prevPos.copy(this.pos);
    const n = t.normal(this.pos.x, this.pos.z, _n);
    // surface under the sled: groomed run (fast), deep powder (slow + grippy),
    // glacier ice (slippery + fast). drives grip + drag below.
    const surf = surfaceAt(this.pos.x, this.pos.z);
    this.surfaceKind = surf.kind;
    // belly slide: low-slung penguin toboggan — slides further (less friction),
    // skids more (less edge grip), steers a touch lazily vs the sled
    const belly = this.state === 'belly';

    // slope-projected gravity → the engine of the game
    const gDotN = -G * n.y;
    this.vel.x += (-n.x * gDotN) * dt;
    this.vel.y += (-G - n.y * gDotN) * dt;
    this.vel.z += (-n.z * gDotN) * dt;

    // steering: D = right, A = left (facing +z, screen-right is -x)
    const steerRaw = inp.axis('KeyA', 'KeyD') + inp.axis('ArrowLeft', 'ArrowRight');
    const steerIn = THREE.MathUtils.clamp(-steerRaw, -1, 1);
    const sp = this.planarSpeed();

    // steering: stronger with speed (weight-shift, not car steering)
    const speedFac = sp / (sp + 7);
    const yawRate = steerIn * 2.2 * this.stats.steer * speedFac * (belly ? 0.85 : 1);
    this.heading += yawRate * dt;
    this.lean = THREE.MathUtils.lerp(this.lean, steerIn, 1 - Math.pow(0.001, dt));

    // forward dir projected onto slope plane
    const fwd = this.headingDir(_f);
    fwd.addScaledVector(n, -fwd.dot(n)).normalize();

    // split velocity: kill lateral (grip), keep forward (momentum)
    const vAlong = this.vel.dot(fwd);
    _lat.copy(this.vel).addScaledVector(fwd, -vAlong);
    const latN = _lat.dot(n);                       // don't damp the normal component
    _lat.addScaledVector(n, -latN);
    // overlean: hard steering at speed overwhelms grip — the sled slides out,
    // and if the slide gets big enough you spin out (lean too hard = wipe)
    const overlean = Math.abs(steerIn) * THREE.MathUtils.clamp((sp - 16) / 14, 0, 1);
    const grip = GRIP * this.stats.grip * surf.grip * (1 - overlean * 0.6) * (belly ? 0.6 : 1);
    const latSpeed = _lat.length();
    this.vel.addScaledVector(_lat, -Math.min(1, grip * dt));
    if (latSpeed > 13 && Math.abs(steerIn) > 0.6 && sp > 18) { this._crash('SPUN OUT!'); return; }

    // gentle carve: rotate residual velocity toward heading
    if (sp > 2) {
      const carve = Math.min(1, CARVE * dt);
      this.vel.x = THREE.MathUtils.lerp(this.vel.x, fwd.x * vAlong, carve);
      this.vel.z = THREE.MathUtils.lerp(this.vel.z, fwd.z * vAlong, carve);
    }

    // brake / paddle / tuck
    const fb = this.input.axis('KeyS', 'KeyW') + this.input.axis('ArrowDown', 'ArrowUp'); // -1 brake .. +1 push
    if (fb < 0 && vAlong > 0.5) this.vel.addScaledVector(fwd, fb * BRAKE * dt);
    if (fb > 0 && vAlong < 7) this.vel.addScaledVector(fwd, fb * PADDLE * dt);
    if (fb < 0 && vAlong <= 0.5 && sp < 1) this.vel.set(0, 0, 0); // full stop, no reversing
    const tucking = fb > 0 && vAlong >= 7; // hold W at speed → tuck, chase terminal velocity

    // quadratic drag → terminal velocity (better sleds = lower drag)
    const v = this.speed();
    if (v > 0.01) this.vel.addScaledVector(this.vel, -DRAG_K * this.stats.drag * surf.drag * (tucking ? TUCK_DRAG : 1) * v * dt);
    // surface friction: a constant deceleration that brings a glide to rest on
    // flat snow but is easily overpowered by gravity on any real slope, so
    // descents still flow. ice is near-frictionless → you keep gliding far;
    // packed runs glide; deep powder grabs and stops you quickly.
    const fm = this.speed();
    if (fm > 1e-4) {
      const fr = surf.fric * (tucking ? 0.6 : 1) * (belly ? 0.5 : 1) * dt;
      this.vel.multiplyScalar(Math.max(0, fm - fr) / fm);
    }
    // soft top-speed cap: gravity still drives you to the cap on any slope, but
    // a near-vertical face can't run the speed away to something that feels broken
    const vc = this.speed();
    if (vc > MAX_SPEED) this.vel.multiplyScalar(MAX_SPEED / vc);

    // integrate + ground constraint (world is infinite — no bounds)
    this.pos.addScaledVector(this.vel, dt);
    const gy = t.height(this.pos.x, this.pos.z);
    const gap = this.pos.y - gy;
    // launch vs hold-the-slope, decided by velocity not by a stick distance.
    // sample the slope AHEAD and find how fast the ground rises/falls along our
    // travel (dH/dt = -slope·vel). for motion that hugs the surface, our own
    // vertical velocity equals that rate exactly. when we're climbing a kicker
    // or cresting a roller and the face flattens/drops out from under us, our
    // upward momentum outruns the ground — gravity can't bend our path back
    // onto it fast enough — and we fly. that surplus rise is the jump.
    const nA = t.normal(this.pos.x, this.pos.z, _n);
    const groundRate = nA.y > 1e-3 ? -(nA.x * this.vel.x + nA.z * this.vel.z) / nA.y : -1e9;
    const launchVN = this.vel.y - groundRate; // >0 = pulling up off the slope ahead
    const fast = this.planarSpeed() > 4;      // too slow to send it → just tip over the lip
    if ((launchVN > LAUNCH_VN && fast) || gap > CLIFF_GAP) {
      // momentum launch: keep the full velocity we carried over the lip (it's
      // already tangent to the take-off face) + a small speed-scaled pop
      const spd = this.vel.length();
      if (spd > 3) this.vel.multiplyScalar(1 + Math.min(POP_MAX, spd * 0.006));
      this._goAirborne();
    } else {
      // pinned to the surface at any angle: drop onto it and cancel only the
      // into-ground velocity so we slide along instead of digging in
      this.pos.y = gy;
      const vn = this.vel.dot(nA);
      if (vn < 0) this.vel.addScaledVector(nA, -vn); // no bounce, just slide
      this.grounded = true;
    }

    // boost pads: a hard shove down the pad's arrow
    this._padCooldown = Math.max(0, (this._padCooldown || 0) - dt);
    if (this.grounded && this._padCooldown <= 0) {
      const pad = this.terrain.hitBooster(this.pos.x, this.pos.z);
      if (pad) {
        this._padCooldown = 2;
        this.vel.x += pad.dx * 11;
        this.vel.z += pad.dz * 11;
        const ps = this.planarSpeed();
        if (ps > 46) { this.vel.x *= 46 / ps; this.vel.z *= 46 / ps; }
        this.hud.trick('BOOST', 0);
      }
    }

    this._checkObstacles();
  }

  _goAirborne() {
    if (this.state !== 'sled' && this.state !== 'belly') return;
    this.state = 'air';
    this.grounded = false;
    this.airPitch = 0;
    this.airSpin = 0;
    this.airTime = 0;
  }

  // ---- airborne -----------------------------------------------------------
  _updateAir(dt) {
    const inp = this.input;
    this.prevPos.copy(this.pos);
    this.airTime += dt;
    this.vel.y -= G * dt;
    // mild air drag: subtle on a normal jump, but caps any launch-chain
    // runaway so speed can't blow up off freak terrain
    const av = this.vel.length();
    if (av > 0.01) this.vel.addScaledVector(this.vel, -DRAG_K * 0.4 * av * dt);
    if (av > MAX_SPEED * 1.15) this.vel.multiplyScalar((MAX_SPEED * 1.15) / av);
    this.pos.addScaledVector(this.vel, dt);

    // tricks: flips (W/S) + spins (A/D)
    const flipIn = inp.axis('KeyS', 'KeyW') + inp.axis('ArrowDown', 'ArrowUp');
    const spinIn = -(inp.axis('KeyA', 'KeyD') + inp.axis('ArrowLeft', 'ArrowRight')); // D = clockwise
    this.airPitch += flipIn * 4.2 * this.stats.flip * dt;
    this.airSpin += spinIn * 3.4 * this.stats.flip * dt;
    this.heading += spinIn * 3.4 * this.stats.flip * dt;
    // gentle auto-level when not flipping: nudges the body toward upright so
    // ordinary jumps land clean, but never strong enough to fight a trick
    if (Math.abs(flipIn) < 0.1) this.airPitch -= wrapAngle(this.airPitch) * 1.4 * dt;

    const gy = this.terrain.height(this.pos.x, this.pos.z);
    if (this.pos.y <= gy) {
      this.pos.y = gy;
      const n = this.terrain.normal(this.pos.x, this.pos.z, _n);
      const vn = this.vel.dot(n);

      // landing orientation check: residual flip rotation vs ground
      const offAxis = Math.abs(wrapAngle(this.airPitch));
      const hardness = -vn;

      if (hardness > CRASH_LAND_VN || offAxis > CRASH_TILT) {
        this._crash(hardness > CRASH_LAND_VN ? 'PANCAKED!' : 'CASED IT!');
        return;
      }

      // clean landing → absorb impact, keep momentum, score tricks
      if (vn < 0) this.vel.addScaledVector(n, -vn);
      // transition landing: touching down on a downslope you're riding
      // returns part of the impact as speed; flat landings bleed instead
      const steep = Math.hypot(n.x, n.z);
      const planar = this.planarSpeed();
      let match = 0;
      if (planar > 1 && steep > 0.02) {
        match = Math.max(0, (this.vel.x * n.x + this.vel.z * n.z) / (planar * steep))
              * Math.min(1, steep / 0.35);
      }
      const recover = hardness * LAND_RECOVER * match;
      if (recover > 0 && planar > 0.5) {
        this.vel.x += (this.vel.x / planar) * recover;
        this.vel.z += (this.vel.z / planar) * recover;
      }
      // hard flat landings bleed speed; slope-matched ones barely do
      if (hardness > 12) this.vel.multiplyScalar(1 - Math.min(0.3, (hardness - 12) * 0.025 * (1 - match * 0.8)));
      this.state = this.groundMode; // back to whatever we launched as (sled / belly)
      this.grounded = true;
      this.landedImpact = hardness; // camera punch
      this.visCushion = Math.min(0.3, hardness * 0.014); // soft visual squish
      this._scoreTricks();
      this.audio?.thump(Math.min(1, hardness / 14));
    }

    this._checkObstacles();
  }

  _scoreTricks() {
    const flips = Math.round(Math.abs(this.airPitch) / (Math.PI * 2));
    const spins = Math.floor(Math.abs(this.airSpin) / Math.PI); // per 180°
    let pts = flips * 150 + spins * 60;
    if (this.airTime > 1.2 && pts === 0) pts = 25; // big air bonus
    if (pts <= 0) return;
    const parts = [];
    if (flips === 1) parts.push(this.airPitch > 0 ? 'BACKFLIP' : 'FRONTFLIP');
    else if (flips > 1) parts.push(`${flips}x FLIP`);
    if (spins > 0) parts.push(`${spins * 180}° SPIN`);
    if (parts.length === 0) parts.push('BIG AIR');
    this.score += pts;
    this.onScore?.(); // persist points (shop currency)
    this.hud.trick(parts.join(' + '), pts);
  }

  // ---- crashing -----------------------------------------------------------
  _checkObstacles() {
    if (this.state === 'crash' || this.state === 'walk') return;
    // swept check: sample along this step's movement so high speed can't
    // tunnel through a trunk between frames
    const dx = this.pos.x - this.prevPos.x, dz = this.pos.z - this.prevPos.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / 0.8));
    let o = null;
    for (let i = 1; i <= steps && !o; i++) {
      const f = i / steps;
      o = this.terrain.hitObstacle(this.prevPos.x + dx * f, this.prevPos.z + dz * f, 0.42);
    }
    if (!o) return;
    const sp = this.planarSpeed();
    if (sp < 18) {
      // forgiving "boing": bounce off the obstacle, lose some speed —
      // only a full-speed hit ends the run
      const ox = this.pos.x - o.x, oz = this.pos.z - o.z;
      const d = Math.hypot(ox, oz) || 1;
      const nx = ox / d, nz = oz / d;
      const vn = this.vel.x * nx + this.vel.z * nz;       // into the trunk?
      if (vn < 0) {                                       // reflect + damp
        this.vel.x -= 1.7 * vn * nx;
        this.vel.z -= 1.7 * vn * nz;
      }
      this.vel.multiplyScalar(sp < 6 ? 0.4 : 0.62);
      this.pos.x = o.x + nx * (o.r + 0.45);               // push clear
      this.pos.z = o.z + nz * (o.r + 0.45);
      this.audio?.thump(Math.min(0.8, sp / 16));
      this.landedImpact = Math.max(this.landedImpact, sp * 0.3); // camera bump
      return;
    }
    this._crash(o.kind === 'tree' ? 'TREE\'D!' : o.kind === 'cabin' ? 'CABIN\'D!' : 'ROCKED!');
  }

  _crash(label) {
    this.state = 'crash';
    this.crashTimer = 2.4;
    this.hud.crash(label);
    this.audio?.crash();

    // rider tumbles forward — somersault dominates, scaled by speed
    const fwd = this.headingDir(_f);
    const sp = this.planarSpeed();
    this.bodyVel.copy(this.vel).multiplyScalar(0.8);
    this.bodyVel.addScaledVector(fwd, 1.5);            // thrown over the front
    this.bodyVel.y = Math.max(this.bodyVel.y + 2.5, 4);
    this.bodySpin.set(
      -(3 + sp * 0.25) + rand(-1.5, 1.5),              // forward somersault
      rand(-2.5, 2.5),
      rand(-3, 3));

    this.sledPos.copy(this.pos).addScaledVector(fwd, 0.5);
    this.sledVel.copy(this.vel).multiplyScalar(0.9);
    this.sledVel.x += rand(-3, 3);
    this.sledVel.y = Math.max(this.sledVel.y, 5);
    this.sledSpin.set(rand(-9, 9), rand(-9, 9), rand(-9, 9));

    this.sled.visible = false;
    this.sledDetached.visible = true;
    this.sledDetached.position.copy(this.sledPos);
    this.vel.set(0, 0, 0);
  }

  _updateCrash(dt) {
    this.crashTimer -= dt;
    const t = this.terrain;

    // rider body: ballistic while airborne, bounce + slide on contact
    this.bodyVel.y -= G * dt;
    this.pos.addScaledVector(this.bodyVel, dt);
    const gy = t.height(this.pos.x, this.pos.z);
    if (this.pos.y < gy) {
      this.pos.y = gy;
      const n = t.normal(this.pos.x, this.pos.z, _n);
      const vn = this.bodyVel.dot(n);
      if (vn < 0) {
        this.bodyVel.addScaledVector(n, -vn * 1.35);   // restitution ≈ 0.35
        // tangential friction: the body skids, then settles
        _v.copy(this.bodyVel).addScaledVector(n, -this.bodyVel.dot(n));
        this.bodyVel.addScaledVector(_v, -0.3);
        this.bodySpin.multiplyScalar(0.6);
        this.audio?.thump(Math.min(0.7, -vn / 18));
      }
    } else if (this.pos.y > gy + 0.5) {
      // airborne ragdoll keeps tumbling freely (no decay until it hits)
      this.bodySpin.multiplyScalar(1);
    }

    // sled body
    this.sledVel.y -= G * dt;
    this.sledPos.addScaledVector(this.sledVel, dt);
    const sy = t.height(this.sledPos.x, this.sledPos.z);
    if (this.sledPos.y < sy) {
      this.sledPos.y = sy;
      const n = t.normal(this.sledPos.x, this.sledPos.z, _n);
      const vn = this.sledVel.dot(n);
      if (vn < 0) this.sledVel.addScaledVector(n, -vn * 1.4);
      this.sledVel.multiplyScalar(0.65);
      this.sledSpin.multiplyScalar(0.7);
    }
    this.sledDetached.position.copy(this.sledPos);
    this.sledDetached.rotation.x += this.sledSpin.x * dt;
    this.sledDetached.rotation.y += this.sledSpin.y * dt;
    this.sledDetached.rotation.z += this.sledSpin.z * dt;

    if (this.crashTimer <= 0) {
      // back on the sled where the rider stopped
      this.sled.visible = true;
      this.sledDetached.visible = false;
      this.vel.set(0, 0, 0);
      this.pos.y = t.height(this.pos.x, this.pos.z);
      const n = t.normal(this.pos.x, this.pos.z, _n);
      this.smoothNormal.copy(n);
      this.state = this.groundMode === 'belly' ? 'belly' : 'sled';
      this.grounded = true;
      this.hud.clearMsg();
    }
  }

  // ---- walking ------------------------------------------------------------
  _updateWalk(dt) {
    const inp = this.input;
    const t = this.terrain;
    // camera-relative movement
    const camYaw = inp.camYaw ?? this.heading;
    let mx = -(inp.axis('KeyA', 'KeyD') + inp.axis('ArrowLeft', 'ArrowRight')); // D = strafe right
    let mz = inp.axis('KeyS', 'KeyW') + inp.axis('ArrowDown', 'ArrowUp');
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }
    const moving = mag > 0.05;

    const sprint = inp.down('ShiftLeft') || inp.down('ShiftRight');
    this.sprinting = sprint && moving;
    if (moving) {
      const a = camYaw;
      const dx = Math.sin(a) * mz + Math.cos(a) * mx;
      const dz = Math.cos(a) * mz - Math.sin(a) * mx;
      this.heading = Math.atan2(dx, dz);
      // uphill is slower; hold Shift to sprint
      const n = t.normal(this.pos.x, this.pos.z, _n);
      const slope = -(n.x * dx + n.z * dz); // >0 walking uphill
      const sp = WALK_SPEED * (sprint ? SPRINT_MULT : 1) * (1 - THREE.MathUtils.clamp(slope, 0, 0.7));
      this.pos.x += dx * sp * dt;
      this.pos.z += dz * sp * dt;
      this.walkCycle += dt * (sprint ? 14 : 9);
    }
    this.pos.y = t.height(this.pos.x, this.pos.z);
    this.vel.set(0, 0, 0);
    this.moving = moving;

    // build a kicker right ahead of where you're facing
    if (inp.consume('KeyG')) {
      t.addRamp(this.pos.x, this.pos.z, this.heading);
      this.hud.trick('KICKER BUILT', 0);
    }
  }

  // ---- visuals ------------------------------------------------------------
  _updateVisuals(dt) {
    const t = this.terrain;

    if (this.state === 'crash') {
      // rig tumbles on its own; limbs flail hard at speed, go limp settling
      this.root.position.copy(this.pos).y += 0.55; // body radius — stay atop the snow
      this.root.rotation.x += this.bodySpin.x * dt;
      this.root.rotation.y += this.bodySpin.y * dt;
      this.root.rotation.z += this.bodySpin.z * dt;
      const flailAmp = Math.min(1, this.bodyVel.length() / 9 + this.bodySpin.length() / 12);
      this.rig.poseFlail(this.time, flailAmp);
    } else {
      this.root.position.copy(this.pos);
      // landing cushion: the body dips for a beat after touchdown, springs back
      this.visCushion = Math.max(0, (this.visCushion || 0) - dt * 1.6);
      this.root.position.y -= this.visCushion;

      // terrain-aligned orientation. snap quickly to the ground normal so the
      // sled lies flush on any slope/wall (laggy smoothing was what let the
      // uphill edge dig into steep faces); ease gently back toward up in the air
      // in the air, ease the reference toward world-up for tricks — but only
      // gradually, so a low pop over a mogul/lip keeps the sled banked to the
      // slope it left (no stiff upright flicker on little hops)
      const n = this.grounded
        ? t.normal(this.pos.x, this.pos.z, _n)
        : _n.set(0, 1, 0);
      const nLerp = this.grounded ? Math.min(1, dt * 26) : 1 - Math.pow(0.2, dt);
      this.smoothNormal.lerp(n, nLerp).normalize();

      if (this.state === 'air') {
        // base orientation hugs the (slowly relaxing) ground normal so small
        // hops look natural; the trick flip rotates on top of it
        const up = this.smoothNormal;
        const fwd = this.headingDir(_f).addScaledVector(up, -_f.dot(up)).normalize();
        const m = new THREE.Matrix4();
        const right = _v.crossVectors(up, fwd).normalize();
        m.makeBasis(right.clone().negate(), up.clone(), fwd.clone());
        _q.setFromRotationMatrix(m);
        const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -this.airPitch);
        _q.multiply(flip);
        this.visQuat.slerp(_q, 1 - Math.pow(0.00001, dt));
        this.rigMount.position.set(0, 0.14, 0.05);
        this.rig.poseSit(this.lean, 1, this.time);
      } else if (this.state === 'walk') {
        _e.set(0, this.heading, 0);
        _q.setFromEuler(_e);
        this.visQuat.slerp(_q, 1 - Math.pow(0.0001, dt));
        this.rigMount.position.set(0, 0, 0); // feet on the snow
        this.rig.poseWalk(dt, this.moving, this.sprinting ? 1.8 : 1);
        this.sled.visible = false;
      } else {
        // sled / belly: align up to smoothed normal, face heading, roll with lean
        const up = this.smoothNormal;
        const fwd = this.headingDir(_f).addScaledVector(up, -_f.dot(up)).normalize();
        const m = new THREE.Matrix4();
        const right = _v.crossVectors(up, fwd).normalize();
        m.makeBasis(right.clone().negate(), up.clone(), fwd.clone()); // -right so +x matches three convention
        _q.setFromRotationMatrix(m);
        const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -this.lean * 0.22);
        _q.multiply(roll);
        this.visQuat.slerp(_q, Math.min(1, dt * 22)); // snap flush to the slope — visibly banks
        const spT = THREE.MathUtils.clamp(this.planarSpeed() / 30, 0, 1);
        if (this.state === 'belly') {
          this.rigMount.position.set(0, 0.04, 0); // flat on the snow
          this.rig.poseBelly(this.lean, spT, this.time);
          this.sled.visible = false;
        } else {
          this.rigMount.position.set(0, 0.14, 0.05); // seated in the saucer dish
          this.rig.poseSit(this.lean, spT, this.time);
          this.sled.visible = true;
        }

        // seat the whole bottom flush on the slope: the body is already banked
        // parallel to smoothNormal, so resting its centre at the ground height
        // directly under it lays the entire base on the snow (no balancing on
        // an uphill corner — that came from lifting to the highest footprint
        // sample, which floated the downhill edge on every traverse). only a
        // genuine bump that rises ABOVE the slope plane lifts the body, so the
        // disc never clips into convex ground.
        const hdx = Math.sin(this.heading), hdz = Math.cos(this.heading);
        const fr = 0.55;
        const gc = t.height(this.pos.x, this.pos.z);     // ground under the centre
        const ny = Math.max(1e-3, this.smoothNormal.y);
        const dHdx = -this.smoothNormal.x / ny, dHdz = -this.smoothNormal.z / ny;
        let lift = 0;
        const samp = [[hdx, hdz], [-hdx, -hdz], [hdz, -hdx], [-hdz, hdx]];
        for (const [ox, oz] of samp) {
          const hh = t.height(this.pos.x + ox * fr, this.pos.z + oz * fr);
          const onPlane = gc + dHdx * (ox * fr) + dHdz * (oz * fr); // slope-plane height there
          const bump = hh - onPlane;                     // how far ground rises off the plane
          if (bump > lift) lift = bump;
        }
        this.root.position.y = gc + lift + (this.state === 'belly' ? BELLY_CLEAR : BODY_CLEAR) - this.visCushion;
      }
      this.root.quaternion.copy(this.visQuat);
      this.root.rotation.order = 'XYZ';
    }

    // blob shadow hugs the terrain
    const gy = t.height(this.pos.x, this.pos.z);
    const n2 = t.normal(this.pos.x, this.pos.z, _v);
    this.shadow.position.set(this.pos.x, gy + 0.06, this.pos.z);
    this.shadow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n2);
    const h = THREE.MathUtils.clamp(this.pos.y - gy, 0, 12);
    this.shadow.material.opacity = 0.2 * (1 - h / 14);
    this.shadow.scale.setScalar(1 + h * 0.08);
  }
}

function wrapAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function rand(a, b) { return a + Math.random() * (b - a); }
