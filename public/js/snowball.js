// Snowballs: aimed throws (ballistic, puff on impact) + a drop-and-roll
// boulder that grows down the hill, leaves a packed trail, bowls over the
// player, and smashes when it hits something or sails off a drop.
import * as THREE from 'three';

const G = 13.5;
const _n = new THREE.Vector3();

export class Snowballs {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.live = [];
    this.puffs = [];
    this.rollers = [];
    this.onScore = null;       // (points) => void
    this.onSquash = null;      // () => void  (player got bowled over)
    this.geo = new THREE.SphereGeometry(0.1, 10, 8);
    this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    this.puffGeo = new THREE.SphereGeometry(0.16, 8, 6);
    this.rollerGeo = new THREE.SphereGeometry(1, 16, 12);
    this.rollerMat = new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 0.85 });

    // packed-snow trail discs the roller leaves behind (pooled)
    this.trailMat = new THREE.MeshBasicMaterial({
      color: 0xcdddec, transparent: true, opacity: 0.5, depthWrite: false,
    });
    this.trailDiscGeo = new THREE.CircleGeometry(1, 16);
    this.trail = [];
    this.trailMax = 90;
  }

  // ballistic thrown snowball; speed set by the aim charge
  throw(origin, dir, speed = 17) {
    if (this.live.length >= 12) return;
    const m = new THREE.Mesh(this.geo, this.mat);
    m.position.copy(origin);
    this.scene.add(m);
    this.live.push({
      m,
      vel: new THREE.Vector3().copy(dir).multiplyScalar(speed).add(new THREE.Vector3(0, 2.5, 0)),
      t: 4,
    });
  }

  // drop a snowball that rolls off downhill on its own and grows
  dropRoller(origin, dir) {
    if (this.rollers.length >= 3) return;
    const m = new THREE.Mesh(this.rollerGeo, this.rollerMat);
    const r = 0.3;
    m.scale.setScalar(r);
    m.position.copy(origin);
    this.scene.add(m);
    this.rollers.push({
      m, r,
      vel: new THREE.Vector3(dir.x * 2, 0, dir.z * 2),
      spin: new THREE.Vector3(),
      falling: false,
      lastTrail: origin.clone(),
    });
  }

  _packTrail(x, z, r) {
    const t = this.terrain;
    let disc;
    if (this.trail.length >= this.trailMax) {
      disc = this.trail.shift();            // recycle oldest
      this.scene.remove(disc);
    }
    disc = disc || new THREE.Mesh(this.trailDiscGeo, this.trailMat);
    disc.position.set(x, t.height(x, z) + 0.05, z);
    t.normal(x, z, _n);
    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _n);
    disc.scale.setScalar(r * 1.1);
    this.scene.add(disc);
    this.trail.push(disc);
  }

  update(dt, player) {
    const t = this.terrain;

    // ---- thrown snowballs -------------------------------------------------
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      b.vel.y -= G * dt;
      b.m.position.addScaledVector(b.vel, dt);
      b.t -= dt;
      const p = b.m.position;
      const gy = t.height(p.x, p.z);
      const hitGround = p.y <= gy + 0.1;
      const hitOb = (p.y - gy < 6) && t.hitObstacle(p.x, p.z, 0.1);
      if (hitGround || hitOb || b.t <= 0) {
        this._splat(p, hitGround ? gy + 0.12 : p.y, 1);
        this.scene.remove(b.m);
        this.live.splice(i, 1);
      }
    }

    // ---- rolling boulders -------------------------------------------------
    for (let i = this.rollers.length - 1; i >= 0; i--) {
      const b = this.rollers[i];
      const p = b.m.position;
      const n = t.normal(p.x, p.z, _n);

      // slope-projected gravity drives it downhill; light rolling drag
      const gDotN = -G * n.y;
      b.vel.x += (-n.x * gDotN) * dt;
      b.vel.z += (-n.z * gDotN) * dt;
      b.vel.y += (-G - n.y * gDotN) * dt;
      b.vel.x *= (1 - 0.6 * dt); b.vel.z *= (1 - 0.6 * dt);

      p.addScaledVector(b.vel, dt);
      const gy = t.height(p.x, p.z);
      const speed = Math.hypot(b.vel.x, b.vel.z);

      // grow as it rolls (Katamari-style), capped
      if (!b.falling && speed > 1.5) {
        b.r = Math.min(3.2, b.r + speed * dt * 0.06);
      }
      b.m.scale.setScalar(b.r);

      // ground contact vs airborne (off a drop)
      if (p.y <= gy + b.r) {
        if (b.falling && b.vel.y < -9) {          // hard landing off a ledge → smash
          this._smashRoller(b, i); continue;
        }
        p.y = gy + b.r;
        const vn = b.vel.dot(n);
        if (vn < 0) b.vel.addScaledVector(n, -vn);
        b.falling = false;
      } else if (p.y > gy + b.r * 1.6) {
        b.falling = true;                          // sailed off a drop
      }

      // roll visual + packed trail
      b.m.rotation.x += speed * dt / Math.max(0.3, b.r);
      if (!b.falling && Math.hypot(p.x - b.lastTrail.x, p.z - b.lastTrail.z) > b.r * 0.6) {
        b.lastTrail.set(p.x, 0, p.z);
        this._packTrail(p.x, p.z, b.r);
      }

      // bowl over the player
      if (player && (player.state === 'sled' || player.state === 'walk')) {
        const dx = player.pos.x - p.x, dz = player.pos.z - p.z;
        if (dx * dx + dz * dz < (b.r + 0.7) ** 2 && Math.abs(player.pos.y - p.y) < b.r + 1.2) {
          this.onSquash?.();
        }
      }

      // smash into an obstacle
      if (t.hitObstacle(p.x, p.z, b.r * 0.7)) { this._smashRoller(b, i); continue; }
      // died out / rolled forever on the flat
      if (speed < 0.6 && !b.falling) { this._smashRoller(b, i); continue; }
    }

    // ---- puffs ------------------------------------------------------------
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const f = this.puffs[i];
      f.t -= dt;
      f.m.scale.setScalar(f.s * (1 + (0.5 - f.t) * 6));
      f.m.material.opacity = Math.max(0, f.t / 0.5) * 0.85;
      if (f.t <= 0) {
        this.scene.remove(f.m);
        f.m.material.dispose();
        this.puffs.splice(i, 1);
      }
    }
  }

  _smashRoller(b, i) {
    const p = b.m.position;
    this._splat(p, p.y, b.r * 2.2);
    // score scales with how big it grew
    const pts = Math.round(b.r * b.r * 40);
    if (pts > 0) this.onScore?.(pts, b.r);
    this.scene.remove(b.m);
    this.rollers.splice(i, 1);
  }

  _splat(p, y, scale = 1) {
    const m = new THREE.Mesh(this.puffGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    m.position.set(p.x, y, p.z);
    this.scene.add(m);
    this.puffs.push({ m, t: 0.5, s: scale });
  }
}
