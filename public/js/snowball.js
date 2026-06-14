// Snowballs: thrown while walking, ballistic, puff on impact.
import * as THREE from 'three';

const G = 13.5;

export class Snowballs {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.live = [];
    this.puffs = [];
    this.geo = new THREE.SphereGeometry(0.1, 10, 8);
    this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    this.puffGeo = new THREE.SphereGeometry(0.16, 8, 6);
  }

  throw(origin, dir) {
    if (this.live.length >= 10) return;
    const m = new THREE.Mesh(this.geo, this.mat);
    m.position.copy(origin);
    this.scene.add(m);
    this.live.push({
      m,
      vel: new THREE.Vector3().copy(dir).multiplyScalar(17).add(new THREE.Vector3(0, 2.5, 0)),
      t: 4,
    });
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      b.vel.y -= G * dt;
      b.m.position.addScaledVector(b.vel, dt);
      b.t -= dt;
      const p = b.m.position;
      const gy = this.terrain.height(p.x, p.z);
      const hitGround = p.y <= gy + 0.1;
      // obstacle footprints are 2D — only count hits near the ground/trunk
      const hitOb = (p.y - gy < 6) && this.terrain.hitObstacle(p.x, p.z, 0.1);
      if (hitGround || hitOb || b.t <= 0) {
        this._splat(p, hitGround ? gy + 0.12 : p.y);
        this.scene.remove(b.m);
        this.live.splice(i, 1);
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const f = this.puffs[i];
      f.t -= dt;
      f.m.scale.setScalar(1 + (0.5 - f.t) * 6);
      f.m.material.opacity = Math.max(0, f.t / 0.5) * 0.85;
      if (f.t <= 0) {
        this.scene.remove(f.m);
        f.m.material.dispose();
        this.puffs.splice(i, 1);
      }
    }
  }

  _splat(p, y) {
    const m = new THREE.Mesh(this.puffGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    m.position.set(p.x, y, p.z);
    this.scene.add(m);
    this.puffs.push({ m, t: 0.5 });
  }
}
