// Chase camera: mouse orbit, positional lag, speed-driven FOV, lean tilt.
import * as THREE from 'three';

const BASE_FOV = 62;
const MAX_FOV = 88;

export class ChaseCam {
  constructor(camera, terrain, input) {
    this.camera = camera;
    this.terrain = terrain;
    this.input = input;
    this.yaw = 0;        // mouse orbit offset (persists — free look)
    this.followYaw = 0;  // smoothed copy of the heading — gently trails travel
    this.pitch = 0.26;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.focus = new THREE.Vector3();  // heavily-smoothed body position the rig orbits
    this.first = true;
    this.shake = 0;
    this._tilt = 0;
    this.aim = 0;          // 0 = chase, 1 = over-the-shoulder aiming
    this.aimTarget = 0;
  }

  impulse(strength) { this.shake = Math.min(1.5, this.shake + strength); }
  setAim(on) { this.aimTarget = on ? 1 : 0; }

  update(player, dt) {
    const [mdx, mdy] = this.input.takeMouse();
    this.yaw -= mdx * 0.0024;          // free look — the orbit offset PERSISTS
    this.pitch = THREE.MathUtils.clamp(this.pitch + mdy * 0.0019, -0.15, 1.1);
    const sp = player.planarSpeed();

    // the camera frame trails the direction of travel only GENTLY, and never
    // while aiming or off the ground — so the view doesn't snap behind the fall
    // line. combined with the persistent mouse offset above, you can point the
    // penguin anywhere and freely look around; the camera won't fight you.
    if (this.first) { this.followYaw = player.heading; this.focus.copy(player.pos); }
    const grounded = player.state === 'sled' || player.state === 'belly';
    if (grounded && this.aimTarget < 0.5) {
      let d = player.heading - this.followYaw;
      d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      this.followYaw += d * (1 - Math.pow(0.25, dt)); // slow, lazy trail
    }

    // ease toward / out of aim (over-the-shoulder)
    this.aim += (this.aimTarget - this.aim) * (1 - Math.pow(0.0006, dt));

    // SMOOTHED FOCUS: the camera orbits this low-passed copy of the body, not
    // the raw sled — so every mogul, lip and knock the sled takes is filtered
    // out of the ride. vertical is smoothed hard (bump chatter lives there);
    // horizontal a touch less so turns still feel responsive.
    const fkXZ = 1 - Math.pow(0.0006, dt);
    const fkY = 1 - Math.pow(0.04, dt);   // ~0.3s time-constant → kills bump jitter
    this.focus.x += (player.pos.x - this.focus.x) * fkXZ;
    this.focus.z += (player.pos.z - this.focus.z) * fkXZ;
    this.focus.y += (player.pos.y - this.focus.y) * fkY;

    const walk = player.state === 'walk';
    const dist = THREE.MathUtils.lerp(walk ? 4.6 : 5.4 + Math.min(2.0, sp * 0.045), 2.5, this.aim);
    const height = THREE.MathUtils.lerp(walk ? 2.2 : 1.9, 1.65, this.aim);
    const worldYaw = this.followYaw + this.yaw + Math.PI; // behind the player
    this.input.camYaw = this.followYaw + this.yaw;        // walk-mode movement frame

    const tx = this.focus.x + Math.sin(worldYaw) * Math.cos(this.pitch) * dist;
    const tz = this.focus.z + Math.cos(worldYaw) * Math.cos(this.pitch) * dist;
    let ty = this.focus.y + height + Math.sin(this.pitch) * dist;

    // keep the camera out of the snow
    const gy = this.terrain.height(tx, tz);
    if (ty < gy + 1.1) ty = gy + 1.1;

    if (this.first) {
      this.pos.set(tx, ty, tz);
      this.first = false;
    } else {
      // gentle spring toward the ideal seat (frame-rate independent)
      const k = 1 - Math.pow(0.0015, dt);
      this.pos.x += (tx - this.pos.x) * k;
      this.pos.y += (ty - this.pos.y) * k;
      this.pos.z += (tz - this.pos.z) * k;
    }

    // look-ahead grows with speed, along actual travel (not the spin heading)
    const fwd = sp > 2
      ? new THREE.Vector3(player.vel.x / sp, 0, player.vel.z / sp)
      : player.headingDir(new THREE.Vector3());
    const lookT = new THREE.Vector3().copy(this.focus)
      .addScaledVector(fwd, Math.min(8, sp * 0.22))
      .add(new THREE.Vector3(0, 1.1, 0));
    const lk = 1 - Math.pow(0.0008, dt);
    this.look.lerp(lookT, this.first ? 1 : lk);

    // shake: crash/landing impulses only (no constant speed chatter — the ride
    // is meant to feel smooth even when the sled is bouncing over rough snow)
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const t = performance.now() * 0.001;
    const ox = (Math.sin(t * 41.1) + Math.sin(t * 29.9)) * this.shake * 0.3;
    const oy = (Math.sin(t * 37.7) + Math.sin(t * 23.3)) * this.shake * 0.3;

    this.camera.position.copy(this.pos).add(new THREE.Vector3(ox, oy, 0));
    // over-the-shoulder: shift to the right so the rider sits left-of-frame
    if (this.aim > 0.001) {
      const vdx = this.look.x - this.camera.position.x, vdz = this.look.z - this.camera.position.z;
      const rl = Math.hypot(vdx, vdz) || 1;
      const rx = vdz / rl, rz = -vdx / rl; // screen-right on the ground
      this.camera.position.x += rx * this.aim * 0.85;
      this.camera.position.z += rz * this.aim * 0.85;
      this.look.x += rx * this.aim * 0.5;
      this.look.z += rz * this.aim * 0.5;
    }
    this.camera.lookAt(this.look);

    // dynamic FOV (eased, capped) — narrows a touch while aiming
    const spT = THREE.MathUtils.clamp((sp - 8) / 28, 0, 1);
    const target = THREE.MathUtils.lerp(BASE_FOV + (MAX_FOV - BASE_FOV) * spT * spT, 52, this.aim);
    this.camera.fov += (target - this.camera.fov) * (1 - Math.pow(0.001, dt));

    // lean tilt
    const tiltTarget = player.state === 'sled' ? -player.lean * 0.06 * spT : 0;
    this._tilt += (tiltTarget - this._tilt) * (1 - Math.pow(0.001, dt));
    this.camera.rotation.z += this._tilt;

    this.camera.updateProjectionMatrix();
  }
}
