// Snow spray (kicked up by the sled), ambient snowfall, and a carve trail.
import * as THREE from 'three';

const _v = new THREE.Vector3();

export class SnowSpray {
  constructor(scene) {
    this.max = 600;
    this.cursor = 0;
    this.positions = new Float32Array(this.max * 3);
    this.velocities = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.13, transparent: true, opacity: 0.75,
      depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(pos, vel, count, spread = 1.6) {
    for (let i = 0; i < count; i++) {
      const j = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      this.positions[j * 3] = pos.x + (Math.random() - 0.5) * 0.5;
      this.positions[j * 3 + 1] = pos.y + 0.15;
      this.positions[j * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.5;
      this.velocities[j * 3] = vel.x * 0.25 + (Math.random() - 0.5) * spread * 2;
      this.velocities[j * 3 + 1] = 1.5 + Math.random() * 2.5;
      this.velocities[j * 3 + 2] = vel.z * 0.25 + (Math.random() - 0.5) * spread * 2;
      this.life[j] = 0.55 + Math.random() * 0.4;
    }
  }

  update(dt, player) {
    // emit from the saucer edge — at the tail when straight, off the carving
    // side when leaning, a big rooster tail when drifting
    if (player.state === 'sled' && player.grounded) {
      const sp = player.planarSpeed();
      if (sp > 4) {
        const drifting = player.input.down('ShiftLeft') || player.input.down('ShiftRight');
        const rate = Math.min(8, sp * 0.22) * (drifting ? 2.4 : 1) * (1 + Math.abs(player.lean));
        const fwd = player.headingDir(new THREE.Vector3());
        const tail = _v.copy(player.pos).addScaledVector(fwd, -0.55);
        // shift toward the outside of the turn
        tail.x += fwd.z * player.lean * 0.5;
        tail.z += -fwd.x * player.lean * 0.5;
        this.emit(tail, player.vel, Math.ceil(rate * dt * 60 * 0.25), drifting ? 2.4 : 1.6);
      }
    }
    if (player.state === 'crash') {
      this.emit(player.pos, player.bodyVel, 2, 2.5);
    }

    for (let j = 0; j < this.max; j++) {
      if (this.life[j] <= 0) continue;
      this.life[j] -= dt;
      this.velocities[j * 3 + 1] -= 9 * dt;
      this.positions[j * 3] += this.velocities[j * 3] * dt;
      this.positions[j * 3 + 1] += this.velocities[j * 3 + 1] * dt;
      this.positions[j * 3 + 2] += this.velocities[j * 3 + 2] * dt;
      if (this.life[j] <= 0) this.positions[j * 3 + 1] = -9999;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

export class Snowfall {
  constructor(scene, count = 1600) {
    this.count = count;
    this.box = 90; // cube around the camera
    this.positions = new Float32Array(count * 3);
    this.speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.positions[i * 3] = (Math.random() - 0.5) * this.box;
      this.positions[i * 3 + 1] = (Math.random() - 0.5) * this.box;
      this.positions[i * 3 + 2] = (Math.random() - 0.5) * this.box;
      this.speeds[i] = 1.5 + Math.random() * 2.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.07, transparent: true, opacity: 0.55,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  update(dt, camPos, wind = 0.6) {
    const b = this.box, hb = b / 2;
    this.points.position.copy(camPos);
    for (let i = 0; i < this.count; i++) {
      let y = this.positions[i * 3 + 1] - this.speeds[i] * dt;
      let x = this.positions[i * 3] + wind * dt;
      if (y < -hb) y += b;
      if (x > hb) x -= b;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3] = x;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// Twinkling snow sparkle: a disc of bright specks around the camera, each
// blinking on its own phase, reseeded as you travel. Cheap stylized shimmer.
export class Sparkle {
  constructor(scene) {
    this.n = 340;
    this.r = 60;
    this.pos = new Float32Array(this.n * 3);
    this.ground = new Float32Array(this.n);
    this.phase = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.phase[i] = Math.random() * 6.28;
      this.pos[i * 3 + 1] = -9999;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.16, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.center = new THREE.Vector3(1e9, 0, 1e9);
    this.t = 0;
  }

  _reseed(cx, cz, terrain) {
    this.center.set(cx, 0, cz);
    for (let i = 0; i < this.n; i++) {
      const a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * this.r;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      this.pos[i * 3] = x;
      this.ground[i] = terrain.height(x, z) + 0.06;
      this.pos[i * 3 + 2] = z;
    }
  }

  update(dt, camPos, terrain) {
    this.t += dt;
    if (Math.hypot(camPos.x - this.center.x, camPos.z - this.center.z) > 22) {
      this._reseed(camPos.x, camPos.z, terrain);
    }
    for (let i = 0; i < this.n; i++) {
      const on = Math.sin(this.t * 3.2 + this.phase[i]) > 0.55; // brief glints
      this.pos[i * 3 + 1] = on ? this.ground[i] : -9999;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// Fading ribbon left in the snow behind the sled.
export class Trail {
  constructor(scene) {
    this.max = 420;            // segments
    this.head = 0;
    this.count = 0;
    const verts = this.max * 2;
    this.positions = new Float32Array(verts * 3);
    this.ages = new Float32Array(this.max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const colors = new Float32Array(verts * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.colors = colors;

    // index buffer: triangle strip as triangles, ring-aware (rebuilt on update)
    this.index = new Uint16Array((this.max - 1) * 6);
    geo.setIndex(new THREE.BufferAttribute(this.index, 1));
    geo.setDrawRange(0, 0);

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.lastSample = new THREE.Vector3(1e9, 0, 1e9);
    this._right = new THREE.Vector3();
  }

  update(dt, player, terrain) {
    // sample a new segment every ~0.6 m while carving
    if (player.state === 'sled' && player.grounded && player.planarSpeed() > 2) {
      if (player.pos.distanceToSquared(this.lastSample) > 0.36) {
        this.lastSample.copy(player.pos);
        const fwd = player.headingDir(new THREE.Vector3());
        this._right.set(fwd.z, 0, -fwd.x).multiplyScalar(0.3);
        const j = this.head;
        this.head = (this.head + 1) % this.max;
        this.count = Math.min(this.count + 1, this.max);
        const lx = player.pos.x - this._right.x, lz = player.pos.z - this._right.z;
        const rx = player.pos.x + this._right.x, rz = player.pos.z + this._right.z;
        this.positions.set([lx, terrain.height(lx, lz) + 0.04, lz], j * 6);
        this.positions.set([rx, terrain.height(rx, rz) + 0.04, rz], j * 6 + 3);
        this.ages[j] = 1;
      }
    }

    // fade ages → vertex color toward snow white
    let tri = 0;
    for (let s = 0; s < this.count - 1; s++) {
      const a = (this.head - this.count + s + this.max * 2) % this.max;
      const b = (a + 1) % this.max;
      if (this.ages[a] <= 0 || this.ages[b] <= 0) continue;
      const i0 = a * 2, i1 = a * 2 + 1, i2 = b * 2, i3 = b * 2 + 1;
      this.index[tri * 6] = i0; this.index[tri * 6 + 1] = i2; this.index[tri * 6 + 2] = i1;
      this.index[tri * 6 + 3] = i1; this.index[tri * 6 + 4] = i2; this.index[tri * 6 + 5] = i3;
      tri++;
    }
    for (let j = 0; j < this.max; j++) {
      if (this.ages[j] <= 0) continue;
      this.ages[j] -= dt * 0.07;
      const f = Math.max(0, this.ages[j]);
      // packed-snow blue groove → fades back to powder
      const r = THREE.MathUtils.lerp(0.95, 0.55, f);
      const g = THREE.MathUtils.lerp(0.96, 0.72, f);
      const bch = THREE.MathUtils.lerp(1.0, 0.93, f);
      for (const v of [j * 2, j * 2 + 1]) {
        this.colors[v * 3] = r; this.colors[v * 3 + 1] = g; this.colors[v * 3 + 2] = bch;
      }
    }
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, tri * 6);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.index.needsUpdate = true;
  }
}
