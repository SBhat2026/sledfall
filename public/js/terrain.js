// Procedural infinite terrain: analytic heightfield (physics samples the
// function directly), streamed as chunks of mesh + merged decoration.
// Features: winding packed-snow trail, downhill-facing kicker ramps, jump
// knolls, mogul fields, nature-pack trees/rocks, log cabins, a lodge,
// boost pads on the run, and player-built kickers.
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/jsm/loaders/GLTFLoader.js';

// ---- deterministic noise -------------------------------------------------
function hash2(ix, iz) {
  let n = (ix * 374761393 + iz * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  const u = smooth(fx), v = smooth(fz);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, z, oct) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5; freq *= 2.07;
  }
  return sum / norm; // 0..1
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sstep(a, b, t) { return smooth(clamp((t - a) / (b - a), 0, 1)); }
// smooth minimum (C1) — blends toward the smaller of a/b without a hard crease
function smin(a, b, k) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return a * h + b * (1 - h) - k * h * (1 - h);
}

// ---- layout --------------------------------------------------------------
const TILT = 0.16;
const KNOLL_CELL = 130;
const RAMP_CELL = 170;
const TRAIL_RAMP_SPACING = 290; // a kicker on the run roughly every 300 m

// smooth macro shape only (mountains + hills) — safe to differentiate.
// mountain amplitude varies by region: gentle meadows ↔ jagged alpine walls
function baseHeight(x, z) {
  let y = -z * TILT;
  const region = 0.55 + 0.9 * fbm(x * 0.00032 + 71.3, z * 0.00032 + 23.9, 2);
  y += (fbm(x * 0.0011 + 13.7, z * 0.0011 + 5.2, 5) - 0.5) * 2 * 150 * region;
  y += (fbm(x * 0.005 + 99.1, z * 0.005 + 31.7, 4) - 0.5) * 2 * 20;
  return y;
}

// three groomed sled runs carve down the mountain; everywhere else is wild
// terrain you have to dodge. each run winds independently (different phase),
// well separated in x so there's always a ridge of obstacles between them.
const RUN_A1 = 56, RUN_W1 = 0.0042, RUN_A2 = 28, RUN_W2 = 0.0011, RUN_A3 = 14, RUN_W3 = 0.013;
const RUNS = [
  { ax: -300, p: 0.4 },
  { ax: 0,    p: 1.3 },   // middle run — the spawn run
  { ax: 300,  p: 4.0 },
];
function runCenter(r, z) {
  return r.ax + RUN_A1 * Math.sin(z * RUN_W1 + r.p)
              + RUN_A2 * Math.sin(z * RUN_W2 + r.p * 1.7)
              + RUN_A3 * Math.sin(z * RUN_W3 + r.p * 0.6);
}
function runCurveAt(r, z) {
  return -RUN_A1 * RUN_W1 * RUN_W1 * Math.sin(z * RUN_W1 + r.p)
         - RUN_A2 * RUN_W2 * RUN_W2 * Math.sin(z * RUN_W2 + r.p * 1.7)
         - RUN_A3 * RUN_W3 * RUN_W3 * Math.sin(z * RUN_W3 + r.p * 0.6);
}
// nearest run to (x,z) → signed cross-distance + its curvature (for banking)
const _nr = { dx: 0, curve: 0 };
function nearestRun(x, z) {
  let bestAbs = Infinity;
  for (const r of RUNS) {
    const dx = x - runCenter(r, z);
    const a = dx < 0 ? -dx : dx;
    if (a < bestAbs) { bestAbs = a; _nr.dx = dx; _nr.curve = runCurveAt(r, z); }
  }
  return _nr;
}

// the spawn / lodge / kickers all reference the middle run
export function trailX(z) { return runCenter(RUNS[1], z); }
// every run's centre x at a given z — for the minimap
export function runCentersAt(z) { return RUNS.map(r => runCenter(r, z)); }
// guaranteed-descent elevation profile shared by every run — the runs always
// flow downhill no matter what the mountains do. Stacked sine layers create
// the rhythm and a wide range of gradients: long steep pitches, mellow benches,
// rollers and micro-steps. amplitudes are tuned so the slope always stays
// negative (≈ -0.11 … -0.60) — steep & varied, but never flat or a back-slope.
function trailProfile(z) {
  return -z * 0.36
       + 26 * Math.sin(z * 0.0042 + 0.9)   // long steep/mellow phases
       + 7  * Math.sin(z * 0.013 + 2.1)    // medium rollers
       + 1.5 * Math.sin(z * 0.031 + 0.4);  // micro-steps
}
// half-pipe stretches: organic z-bands where the run becomes a steep-walled
// U you can pump and launch out of. 0 → normal groove, 1 → full pipe.
function halfpipe(z) {
  return sstep(0.63, 0.74, fbm(z * 0.0016 + 300.0, 7.0, 2));
}
// 1 on the nearest run's centre → 0 off-run (grooming / colour width)
export function trailFactor(x, z) {
  const dx = nearestRun(x, z).dx;
  return 1 - sstep(5, 17, dx < 0 ? -dx : dx);
}
// narrower wide blend (so the three carves don't merge) that carves run
// elevation into the mountainside
function trailFactorWide(x, z) {
  const dx = nearestRun(x, z).dx;
  return 1 - sstep(8, 44, dx < 0 ? -dx : dx);
}

const SPAWN_Z = 540;                         // midway down the slope
export const SPAWN = { x: trailX(SPAWN_Z), z: SPAWN_Z };
// initial heading: down the run's tangent
export const SPAWN_HEADING = Math.atan2((trailX(SPAWN_Z + 5) - trailX(SPAWN_Z - 5)) / 10, 1);

// the lodge: a big cabin beside the spawn, on a flattened pad — the shop hub.
// pad height comes from the smooth macro layers only (no recursion).
export const LODGE = (() => {
  const z = SPAWN_Z - 12, x = trailX(z) - 40;
  const tfw = 1 - sstep(8, 44, 40);
  const y = baseHeight(x, z) * (1 - tfw * 0.92) + trailProfile(z) * (tfw * 0.92);
  return { x, z, y, r: 24 };
})();

// ---- biomes / surfaces ----------------------------------------------------
// moderate-size zones: forest (the common one, dense pines), open (sparse),
// and rare all-ice glaciers. drives tree density, surface grip and colour.
function glacierField(x, z) { return fbm(x * 0.0013 + 401, z * 0.0013 + 88, 2); }
function forestField(x, z)  { return fbm(x * 0.0017 + 77,  z * 0.0017 + 150, 3); }
// 0 → not ice, 1 → solid glacier (soft edge so it blends in)
function glacierMask(x, z) { return sstep(0.70, 0.80, glacierField(x, z)); }
// 'glacier' | 'open' | 'forest'
function biomeAt(x, z) {
  if (glacierField(x, z) > 0.74) return 'glacier';
  return forestField(x, z) < 0.36 ? 'open' : 'forest';
}
// frozen ponds: rare flat ice discs tucked off the runs — glassy landmarks
// you can skate across. cached on a sparse lattice.
const POND_CELL = 260;
const pondCache = new Map();
function pondAt(ax, az) {
  const key = ax + ',' + az;
  let p = pondCache.get(key);
  if (p !== undefined) return p;
  if (hash2(ax * 17 + 5, az * 31 + 9) > 0.16) { pondCache.set(key, null); return null; }
  const bx = (ax + 0.3 + 0.4 * hash2(ax, az)) * POND_CELL;
  const bz = (az + 0.3 + 0.4 * hash2(az + 4, ax + 2)) * POND_CELL;
  if (Math.abs(nearestRun(bx, bz).dx) < 55) { pondCache.set(key, null); return null; }
  // only on gentle ground — flattening a steep spot makes a launch-ramp edge
  const e = 5;
  const gx = (baseHeight(bx + e, bz) - baseHeight(bx - e, bz)) / (2 * e);
  const gz = (baseHeight(bx, bz + e) - baseHeight(bx, bz - e)) / (2 * e);
  if (Math.hypot(gx, gz) > 0.18) { pondCache.set(key, null); return null; }
  p = { bx, bz, r: 15 + hash2(ax + 3, az + 7) * 13, level: baseHeight(bx, bz) - 0.8 };
  pondCache.set(key, p);
  return p;
}
function pondInfluence(x, z) {
  const cx = Math.floor(x / POND_CELL), cz = Math.floor(z / POND_CELL);
  let best = 0, level = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const p = pondAt(cx + i, cz + j);
    if (!p) continue;
    const d = Math.hypot(x - p.bx, z - p.bz);
    if (d > p.r) continue;
    const f = 1 - sstep(0.45, 1, d / p.r); // gentle shore so the edge isn't a ramp
    if (f > best) { best = f; level = p.level; }
  }
  return best > 0 ? { f: best, level } : null;
}

// surface the sled rides: groomed run, slick ice (glacier or pond), or powder.
// returns grip / drag multipliers + a label for effects.
// fric = constant rolling deceleration (m/s²): groomed run glides and keeps
// flowing on the descent, deep powder grabs and halts a flat glide quickly,
// ice is near-frictionless so you skate a long way.
export function surfaceAt(x, z) {
  if (trailFactor(x, z) > 0.45) return { kind: 'groomed', grip: 1.0, drag: 0.95, fric: 1.0 };
  if (glacierField(x, z) > 0.72 || pondInfluence(x, z)) return { kind: 'ice', grip: 0.34, drag: 0.7, fric: 0.3 };
  return { kind: 'powder', grip: 1.12, drag: 1.32, fric: 4.0 };
}

// player-built kickers: injected into the height function so physics and
// the mesh always agree; nearby chunks get rebuilt when one is placed
const userRamps = [];

// kicker ramps: sparse lattice, each ramp faces downhill (smooth gradient)
const rampCache = new Map();
function rampAt(ax, az) {
  const key = ax + ',' + az;
  let r = rampCache.get(key);
  if (r !== undefined) return r;
  if (hash2(ax * 5 + 3, az * 11 + 1) > 0.34) {
    rampCache.set(key, null);
    return null;
  }
  const bx = (ax + 0.25 + 0.5 * hash2(ax, az * 3 + 7)) * RAMP_CELL;
  const bz = (az + 0.25 + 0.5 * hash2(ax * 7 + 2, az)) * RAMP_CELL;
  // downhill direction from the smooth macro shape
  const e = 3;
  const gx = (baseHeight(bx + e, bz) - baseHeight(bx - e, bz)) / (2 * e);
  const gz = (baseHeight(bx, bz + e) - baseHeight(bx, bz - e)) / (2 * e);
  const gl = Math.hypot(gx, gz) || 1;
  // size class biased toward small/medium, with the occasional huge booter;
  // bigger lips get a longer rising face + wider deck so they stay rideable
  const sz = hash2(ax + 9, az + 4);
  const h = 3.5 + sz * sz * 18;                  // ≈ 3.5 .. 21.5 m
  r = {
    bx, bz,
    dx: -gx / gl, dz: -gz / gl,                  // unit downhill
    h,
    len: 13 + sz * 16,                           // 13..29 m face (scales with height)
    w: 8 + hash2(ax + 1, az + 8) * 11,           // 8..19 m wide
  };
  rampCache.set(key, r);
  return r;
}

export function terrainHeight(x, z) {
  let y = baseHeight(x, z);

  // nearest of the three runs — drives carving, grooming and banking
  const nr = nearestRun(x, z);
  const adx = nr.dx < 0 ? -nr.dx : nr.dx;

  // carve the guaranteed-descent run into the mountainside
  const tfw = 1 - sstep(8, 44, adx);
  if (tfw > 0) y = y * (1 - tfw * 0.92) + trailProfile(z) * (tfw * 0.92);

  // cap canyon walls: near a run the mountainside can't tower more than a
  // gentle rise above the trail, so the descent never becomes a deep slot
  // canyon with sheer walls. far from the runs (>220 m), peaks rise freely.
  if (adx < 220) {
    const ceil = trailProfile(z) + 16 + adx * 0.5; // rises ≈0.5 m / m out
    y = smin(y, ceil, 9);
  }

  // flattened pad under the lodge
  {
    const ld2 = (x - LODGE.x) ** 2 + (z - LODGE.z) ** 2;
    if (ld2 < LODGE.r * LODGE.r) {
      const f = 1 - sstep(0.34, 1, Math.sqrt(ld2) / LODGE.r);
      y = y * (1 - f) + LODGE.y * f;
    }
  }

  // frozen ponds: flatten to a glassy ice level
  const pond = pondInfluence(x, z);
  if (pond) y = y * (1 - pond.f) + pond.level * pond.f;

  const tf = 1 - sstep(5, 17, adx);
  // glaciers + ponds read as smooth glassy ice — flatten chatter + moguls
  const ice = Math.max(glacierMask(x, z), pond ? pond.f : 0);
  const rough = (1 - tf * 0.9) * (1 - ice * 0.92); // groomed run & ice = smooth

  // surface chatter
  y += (fbm(x * 0.03 + 7.7, z * 0.03 + 1.3, 3) - 0.5) * 2 * 1.9 * rough;

  // mogul fields, region-gated, never on the trail or glaciers
  const mg = sstep(0.62, 0.78, fbm(x * 0.004 + 211, z * 0.004 + 77, 2)) * rough;
  if (mg > 0) y += Math.sin(x * 0.52) * Math.sin(z * 0.47) * 1.25 * mg;

  // trail groove: shallow half-pipe channel that cradles the sled,
  // plus banked turns — the outside edge rises into the corner so fast
  // riders are carried through instead of thrown off the run
  if (tf > 0) {
    const dx = nr.dx;
    y += -1.6 * tf + (dx * dx) * 0.012 * tf;     // dip + parabolic walls
    y += -nr.curve * dx * 42 * tf;               // superelevation into the turn

    // half-pipe stretches: steep curved walls (concave so you hold the slope
    // riding up) that crest into a convex lip — carry speed up the wall and the
    // launch test throws you clean out the top
    const hp = halfpipe(z);
    if (hp > 0) {
      const adx = dx < 0 ? -dx : dx;
      const WT = 15;                              // lip ≈ 15 m off centre
      const wall = sstep(2.5, WT, adx);           // 0 at centre → 1 at the lip
      y += hp * tf * wall * wall * 8.5;           // up to ~8.5 m walls
      const lip = Math.exp(-((adx - WT) ** 2) / (2 * 3 * 3)); // kick at the very top
      y += hp * tf * lip * 1.3;
    }
  }

  // jump knolls (rounded bumps)
  {
    const cx = Math.floor(x / KNOLL_CELL), cz = Math.floor(z / KNOLL_CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const ax = cx + i, az = cz + j;
      if (hash2(ax * 3 + 1, az * 7 + 2) > 0.3) continue;
      const bx = (ax + 0.2 + 0.6 * hash2(ax, az * 5 + 3)) * KNOLL_CELL;
      const bz = (az + 0.2 + 0.6 * hash2(ax * 9 + 4, az)) * KNOLL_CELL;
      const ddx = x - bx, ddz = z - bz, d2 = ddx * ddx + ddz * ddz;
      const r = 8 + hash2(ax + 7, az + 11) * 8;
      if (d2 > r * r * 9) continue;
      const h = 3.5 + hash2(ax + 3, az + 9) * 5;
      y += h * Math.exp(-d2 / (2 * r * r * 0.25)) * (1 - tf * 0.7);
    }
  }

  // kicker ramps: rise to a lip, then a sheer drop → guaranteed air
  {
    const cx = Math.floor(x / RAMP_CELL), cz = Math.floor(z / RAMP_CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const r = rampAt(cx + i, cz + j);
      if (r) y += rampHeight(r, x, z);
    }
  }

  // kickers sitting right on the run, spaced down the mountain
  {
    const k = Math.floor(z / TRAIL_RAMP_SPACING);
    for (let j = -1; j <= 1; j++) {
      const r = trailRampAt(k + j);
      if (r) y += rampHeight(r, x, z);
    }
  }

  // player-built kickers
  for (let i = 0; i < userRamps.length; i++) y += rampHeight(userRamps[i], x, z);

  return y;
}

function rampHeight(r, x, z) {
  const ddx = x - r.bx, ddz = z - r.bz;
  const s = ddx * r.dx + ddz * r.dz;            // along launch direction
  if (s < -r.len || s > 5) return 0;
  const p = ddx * -r.dz + ddz * r.dx;           // across
  if (Math.abs(p) > r.w * 3) return 0;
  const across = Math.exp(-(p * p) / (2 * r.w * r.w));
  const profile = s < 0
    ? smooth((s + r.len) / r.len)               // rising face
    : Math.max(0, 1 - s / 4.5);                 // sheer back drop
  return r.h * profile * across;
}

// kickers planted on the trail itself, facing down the run
const trailRampCache = new Map();
function trailRampAt(k) {
  let r = trailRampCache.get(k);
  if (r !== undefined) return r;
  if (hash2(k * 13 + 5, k * 29 + 11) > 0.7) {
    trailRampCache.set(k, null);
    return null;
  }
  const bz = (k + 0.5) * TRAIL_RAMP_SPACING;
  const bx = trailX(bz);
  // launch direction = trail tangent (downhill along the run)
  const tx = (trailX(bz + 5) - trailX(bz - 5)) / 10;
  const tl = Math.hypot(tx, 1);
  // varied trail jumps: mostly small/medium tabletops, the odd big one
  const sz = hash2(k * 3 + 1, k * 7 + 9);
  r = {
    bx, bz,
    dx: tx / tl, dz: 1 / tl,
    h: 3 + sz * sz * 11,                        // 3..14 m
    len: 14 + sz * 12, w: 11,
  };
  trailRampCache.set(k, r);
  return r;
}

// boost pads on the run: one ahead of each trail kicker (line it up, hit it
// fast, fly) and one on stretches that have no kicker
function boosterAt(k) {
  const r = trailRampAt(k);
  if (r) {
    return { id: k, x: r.bx - r.dx * (r.len + 26), z: r.bz - r.dz * (r.len + 26), dx: r.dx, dz: r.dz };
  }
  const bz = (k + 0.5) * TRAIL_RAMP_SPACING - 40;
  const tx = (trailX(bz + 5) - trailX(bz - 5)) / 10;
  const tl = Math.hypot(tx, 1);
  return { id: k, x: trailX(bz), z: bz, dx: tx / tl, dz: 1 / tl };
}

const EPS = 0.55;
export function terrainNormal(x, z, out = new THREE.Vector3()) {
  const hx = (terrainHeight(x + EPS, z) - terrainHeight(x - EPS, z)) / (2 * EPS);
  const hz = (terrainHeight(x, z + EPS) - terrainHeight(x, z - EPS)) / (2 * EPS);
  return out.set(-hx, 1, -hz).normalize();
}

function forestDensity(x, z) {
  return sstep(0.36, 0.62, fbm(x * 0.0021 + 501, z * 0.0021 + 9.4, 3));
}

// ---- chunk streaming -------------------------------------------------------
const CHUNK = 150;
const SEG = 36;
const VIEW = 4;
const BUILDS_PER_FRAME = 2;

// extract non-indexed positions + smooth normals from a template geometry
function template(geo, y, color, zOff = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  return {
    pos: g.attributes.position.array.slice(),
    nor: g.attributes.normal.array.slice(),
    y, color, zOff,
  };
}

// tall rounded pines: long trunk + three stacked smooth cones (snow on top)
const TEMPLATES = {
  trunk: template(new THREE.CylinderGeometry(0.16, 0.24, 3.2, 9), 1.6, [0.27, 0.19, 0.13]),
  tier1: template(new THREE.ConeGeometry(1.85, 2.6, 10), 4.0, [0.10, 0.25, 0.18]),
  tier2: template(new THREE.ConeGeometry(1.45, 2.3, 10), 5.6, [0.12, 0.28, 0.20]),
  tier3: template(new THREE.ConeGeometry(1.0, 2.0, 10), 7.1, [0.14, 0.31, 0.22]),
  cap:   template(new THREE.ConeGeometry(0.62, 1.0, 10), 8.3, [0.96, 0.97, 1.0]),
  rock:  template(new THREE.IcosahedronGeometry(1, 1), 0.25, [0.62, 0.67, 0.73]),
  cabinBody: template(new THREE.BoxGeometry(6, 3.2, 5), 1.5, [0.36, 0.24, 0.15]),
  cabinRoof: template(new THREE.ConeGeometry(4.6, 2.4, 4), 4.3, [0.93, 0.95, 1.0]),
  cabinDoor: template(new THREE.BoxGeometry(1.0, 1.8, 0.2), 0.9, [0.2, 0.13, 0.08], 2.55),
  // boost pad: bright disc + squat triangular arrow pointing down the run
  boostDisc: template(new THREE.CylinderGeometry(1.8, 1.9, 0.12, 22), 0.06, [1.0, 0.52, 0.1]),
  boostArrow: template(new THREE.ConeGeometry(0.85, 0.3, 3), 0.2, [1.0, 0.93, 0.75]),
};

// ---- nature pack (user's converted GLB models) -----------------------------
// each model becomes a stamp template with per-vertex colors baked from its
// flat materials; the pack's lavender "Snow" is overridden to match the world
const NATURE = { ready: false };
const NATURE_FILES = {
  pine2: 'PineTree_Snow_2', pine5: 'PineTree_Snow_5', common4: 'CommonTree_Snow_4',
  willow1: 'Willow_Snow_1', willowDead: 'Willow_Dead_Snow_4',
  rock3: 'Rock_Snow_3', rock6: 'Rock_Snow_6',
  stump: 'TreeStump_Snow', log: 'WoodLog_Snow',
};
async function loadNature(onReady) {
  try {
    const loader = new GLTFLoader();
    await Promise.all(Object.entries(NATURE_FILES).map(async ([key, name]) => {
      const gltf = await loader.loadAsync(`/assets/${name}.glb`);
      gltf.scene.updateMatrixWorld(true);
      const pos = [], nor = [], col = [];
      gltf.scene.traverse(o => {
        if (!o.isMesh) return;
        const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
        g.applyMatrix4(o.matrixWorld);
        const p = g.attributes.position.array, nn = g.attributes.normal.array;
        const snow = /snow/i.test(o.material?.name || '');
        const mc = o.material?.color;
        const c = snow ? [0.93, 0.95, 1.0] : [mc?.r ?? 0.5, mc?.g ?? 0.5, mc?.b ?? 0.5];
        for (let i = 0; i < p.length; i += 3) {
          pos.push(p[i], p[i + 1], p[i + 2]);
          nor.push(nn[i], nn[i + 1], nn[i + 2]);
          col.push(c[0], c[1], c[2]);
        }
        g.dispose();
      });
      NATURE[key] = {
        pos: new Float32Array(pos), nor: new Float32Array(nor),
        col: new Float32Array(col), y: 0, color: [1, 1, 1],
      };
    }));
    NATURE.ready = true;
    onReady?.();
  } catch (err) {
    console.warn('nature pack failed to load — procedural decorations kept:', err);
  }
}

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();
    this.queue = [];

    this.groundMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.96, metalness: 0,
    });
    this.decoMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, metalness: 0,
    });
    // unlit → reads as glowing against the lit snow
    this.boostMat = new THREE.MeshBasicMaterial({ vertexColors: true });

    this._lastP = { x: SPAWN.x, z: SPAWN.z };
    loadNature(() => this._rebuildAll()); // re-skin the world once models land

    this.update(SPAWN.x, SPAWN.z);
    for (const item of this.queue.splice(0)) {
      if (item.d2 <= 2) this._buildChunk(item.cx, item.cz);
      else this.queue.push(item);
    }
  }

  height(x, z) { return terrainHeight(x, z); }
  normal(x, z, out) { return terrainNormal(x, z, out); }

  update(px, pz) {
    this._lastP.x = px; this._lastP.z = pz;
    const ccx = Math.round(px / CHUNK), ccz = Math.round(pz / CHUNK);

    for (let i = -VIEW; i <= VIEW; i++) for (let j = -VIEW; j <= VIEW; j++) {
      const cx = ccx + i, cz = ccz + j;
      const d2 = i * i + j * j;
      if (d2 > (VIEW + 0.5) ** 2) continue;
      const key = `${cx},${cz}`;
      if (this.chunks.has(key)) continue;
      this.chunks.set(key, 'pending');
      this.queue.push({ cx, cz, d2 });
    }

    if (this.queue.length) {
      this.queue.sort((a, b) =>
        ((a.cx - ccx) ** 2 + (a.cz - ccz) ** 2) - ((b.cx - ccx) ** 2 + (b.cz - ccz) ** 2));
      for (let n = 0; n < BUILDS_PER_FRAME && this.queue.length; n++) {
        const { cx, cz } = this.queue.shift();
        this._buildChunk(cx, cz);
      }
    }

    for (const [key, c] of this.chunks) {
      const [cx, cz] = key.split(',').map(Number);
      if ((cx - ccx) ** 2 + (cz - ccz) ** 2 <= (VIEW + 1.5) ** 2) continue;
      this._disposeChunk(c);
      this.chunks.delete(key);
    }
  }

  _disposeChunk(c) {
    if (c === 'pending') return;
    this.scene.remove(c.ground);
    c.ground.geometry.dispose();
    if (c.deco) { this.scene.remove(c.deco); c.deco.geometry.dispose(); }
    if (c.boost) { this.scene.remove(c.boost); c.boost.geometry.dispose(); }
  }

  // throw away every built chunk and stream the area again (model swap)
  _rebuildAll() {
    for (const [key, c] of this.chunks) {
      this._disposeChunk(c);
      this.chunks.delete(key);
    }
    this.queue.length = 0;
    this.update(this._lastP.x, this._lastP.z);
  }

  // a player-built kicker: lip lands ~24 m ahead so the rise starts just
  // past your toes; physics picks it up via the height function
  addRamp(x, z, heading) {
    const dx = Math.sin(heading), dz = Math.cos(heading);
    const r = { bx: x + dx * 24, bz: z + dz * 24, dx, dz, h: 6.5, len: 17, w: 8 };
    userRamps.push(r);
    if (userRamps.length > 14) userRamps.shift(); // keep the hot path cheap
    // rebuild every built chunk the ramp could touch
    const ccx = Math.round(r.bx / CHUNK), ccz = Math.round(r.bz / CHUNK);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const key = `${ccx + i},${ccz + j}`;
      const c = this.chunks.get(key);
      if (c && c !== 'pending') {
        this._disposeChunk(c);
        this.chunks.delete(key);
        this._buildChunk(ccx + i, ccz + j);
      }
    }
    return true;
  }

  // boost pad lookup (returns the pad if (x,z) is on one)
  hitBooster(x, z) {
    const ccx = Math.round(x / CHUNK), ccz = Math.round(z / CHUNK);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const c = this.chunks.get(`${ccx + i},${ccz + j}`);
      if (!c || c === 'pending' || !c.boosters) continue;
      for (const b of c.boosters) {
        const dx = b.x - x, dz = b.z - z;
        if (dx * dx + dz * dz < 2.1 * 2.1) return b;
      }
    }
    return null;
  }

  hitObstacle(x, z, radius) {
    const ccx = Math.round(x / CHUNK), ccz = Math.round(z / CHUNK);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const c = this.chunks.get(`${ccx + i},${ccz + j}`);
      if (!c || c === 'pending') continue;
      for (const o of c.obstacles) {
        const dx = o.x - x, dz = o.z - z, rr = o.r + radius;
        if (dx * dx + dz * dz < rr * rr) return o;
      }
    }
    return null;
  }

  _buildChunk(cx, cz) {
    const ox = cx * CHUNK, oz = cz * CHUNK;

    // ground mesh with vertex colors: white powder → packed blue trail.
    // normals come from the analytic height function so shading is silky
    // smooth and chunk borders are seamless
    const geo = new THREE.PlaneGeometry(CHUNK, CHUNK, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const gcols = new Float32Array(pos.count * 3);
    const nv = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + ox, wz = pos.getZ(i) + oz;
      pos.setY(i, terrainHeight(wx, wz));
      terrainNormal(wx, wz, nv);
      nor.setXYZ(i, nv.x, nv.y, nv.z);
      const tf = trailFactor(wx, wz);
      const pondI = pondInfluence(wx, wz);
      const ice = Math.max(glacierMask(wx, wz), pondI ? pondI.f : 0);
      // soft slope shading: flats stay bright, steeper faces cool + darken a
      // touch so the terrain reads with form (stylised, no textures)
      const shade = 1 - (1 - nv.y) * 0.28;
      // base powder white → packed-snow blue on the groomed runs
      let r = 0.95 - tf * 0.30;
      let g = 0.965 - tf * 0.16;
      let b = 1.0;
      // glacier ice: glassy cyan-blue
      r += (0.66 - r) * ice;
      g += (0.85 - g) * ice;
      b += (0.98 - b) * ice;
      gcols[i * 3] = r * shade;
      gcols[i * 3 + 1] = g * shade;
      gcols[i * 3 + 2] = b * (1 - (1 - nv.y) * 0.05); // keep highlights blue-cool
    }
    geo.setAttribute('color', new THREE.BufferAttribute(gcols, 3));
    const ground = new THREE.Mesh(geo, this.groundMat);
    ground.position.set(ox, 0, oz);
    this.scene.add(ground);

    // decoration: pines, rocks, the odd log cabin — merged into one mesh
    const obstacles = [];
    const verts = [], cols = [], nors = [];
    let seed = (cx * 73856093) ^ (cz * 19349663);
    const rng = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    const n = new THREE.Vector3();

    // the lodge (fixed spot near the spawn peak)
    if (Math.abs(LODGE.x - ox) <= CHUNK / 2 && Math.abs(LODGE.z - oz) <= CHUNK / 2) {
      const yaw = Math.PI / 2; // door faces the run
      const by = LODGE.y - 0.5; // settle the base into the pad
      this._stamp(verts, cols, nors, TEMPLATES.cabinBody, LODGE.x, by, LODGE.z, 2.2, yaw);
      this._stamp(verts, cols, nors, TEMPLATES.cabinRoof, LODGE.x, by, LODGE.z, 2.2, yaw + Math.PI / 4);
      this._stamp(verts, cols, nors, TEMPLATES.cabinDoor, LODGE.x, by, LODGE.z, 2.2, yaw);
      if (NATURE.ready) { // wood pile + stumps out front
        this._stamp(verts, cols, nors, NATURE.log, LODGE.x - 9, terrainHeight(LODGE.x - 9, LODGE.z + 8), LODGE.z + 8, 2.0, 0.6);
        this._stamp(verts, cols, nors, NATURE.stump, LODGE.x - 11, terrainHeight(LODGE.x - 11, LODGE.z + 4), LODGE.z + 4, 1.8, 2.2);
      }
      obstacles.push({ x: LODGE.x, z: LODGE.z, r: 8.6, kind: 'cabin' });

      // a little village: a few smaller cabins clustered around the lodge
      const village = [[-22, -6, 1.1], [-18, 16, 0.9], [16, -18, 1.0], [24, 10, 0.85]];
      for (const [vx, vz, vs] of village) {
        const wx = LODGE.x + vx, wz = LODGE.z + vz;
        if ((wx - SPAWN.x) ** 2 + (wz - SPAWN.z) ** 2 < 12 * 12) continue; // clear of spawn
        const wy = terrainHeight(wx, wz);
        const vyaw = Math.atan2(LODGE.x - wx, LODGE.z - wz); // face the lodge
        this._stamp(verts, cols, nors, TEMPLATES.cabinBody, wx, wy, wz, vs, vyaw);
        this._stamp(verts, cols, nors, TEMPLATES.cabinRoof, wx, wy, wz, vs, vyaw + Math.PI / 4);
        this._stamp(verts, cols, nors, TEMPLATES.cabinDoor, wx, wy, wz, vs, vyaw);
        obstacles.push({ x: wx, z: wz, r: 3.4 * vs, kind: 'cabin' });
      }
    }

    // boost pads on the run (in front of trail kickers / on empty stretches)
    const boosters = [];
    const bverts = [], bcols = [], bnors = [];
    {
      const k0 = Math.floor((oz - CHUNK / 2) / TRAIL_RAMP_SPACING) - 1;
      const k1 = Math.floor((oz + CHUNK / 2) / TRAIL_RAMP_SPACING) + 1;
      for (let k = k0; k <= k1; k++) {
        const b = boosterAt(k);
        if (Math.abs(b.x - ox) > CHUNK / 2 || Math.abs(b.z - oz) > CHUNK / 2) continue;
        const by = terrainHeight(b.x, b.z);
        const yaw = Math.atan2(b.dx, b.dz);
        this._stamp(bverts, bcols, bnors, TEMPLATES.boostDisc, b.x, by, b.z, 1, yaw);
        this._stamp(bverts, bcols, bnors, TEMPLATES.boostArrow, b.x, by, b.z, 1, yaw);
        boosters.push(b);
      }
    }

    // guidance rows: trees flanking each run every ~15 m — they read the
    // path ahead and rush past close to the sled (parallax = speed)
    for (const run of RUNS) {
      if (Math.abs(runCenter(run, oz) - ox) >= CHUNK * 0.85) continue;
      for (let wz = oz - CHUNK / 2 + rng() * 15; wz < oz + CHUNK / 2; wz += 13 + rng() * 9) {
        const side = rng() < 0.5 ? -1 : 1;
        const wx = runCenter(run, wz) + side * (18 + rng() * 7);
        if (wx < ox - CHUNK / 2 || wx > ox + CHUNK / 2) continue;
        if ((wx - SPAWN.x) ** 2 + (wz - SPAWN.z) ** 2 < 16 * 16) continue;
        if ((wx - LODGE.x) ** 2 + (wz - LODGE.z) ** 2 < (LODGE.r + 3) ** 2) continue;
        if (glacierMask(wx, wz) > 0.5) continue;     // glaciers stay open ice
        terrainNormal(wx, wz, n);
        if (n.y < 0.6) continue;
        const wy = terrainHeight(wx, wz);
        const yaw = rng() * Math.PI * 2;
        if (NATURE.ready) {
          const tpl = rng() < 0.6 ? NATURE.pine2 : NATURE.pine5;
          const s = 2.2 + rng() * 1.6;
          this._stamp(verts, cols, nors, tpl, wx, wy, wz, s, yaw);
          obstacles.push({ x: wx, z: wz, r: 0.17 * s, kind: 'tree' });
        } else {
          const s = 0.9 + rng() * 1.2;
          this._stamp(verts, cols, nors, TEMPLATES.trunk, wx, wy, wz, s, yaw);
          this._stamp(verts, cols, nors, TEMPLATES.tier1, wx, wy, wz, s, yaw);
          this._stamp(verts, cols, nors, TEMPLATES.tier2, wx, wy, wz, s, yaw + 0.5);
          this._stamp(verts, cols, nors, TEMPLATES.tier3, wx, wy, wz, s, yaw + 1.1);
          obstacles.push({ x: wx, z: wz, r: 0.26 * s, kind: 'tree' });
        }
      }
    }

    // rare cabin beside a run
    if (rng() < 0.16) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const wx = ox + (rng() - 0.5) * CHUNK, wz = oz + (rng() - 0.5) * CHUNK;
        const dTrail = Math.abs(nearestRun(wx, wz).dx);
        if (dTrail < 13 || dTrail > 48) continue;
        terrainNormal(wx, wz, n);
        if (n.y < 0.86) continue;
        const wy = terrainHeight(wx, wz);
        const yaw = rng() * Math.PI * 2;
        this._stamp(verts, cols, nors, TEMPLATES.cabinBody, wx, wy, wz, 1, yaw);
        this._stamp(verts, cols, nors, TEMPLATES.cabinRoof, wx, wy, wz, 1, yaw + Math.PI / 4);
        this._stamp(verts, cols, nors, TEMPLATES.cabinDoor, wx, wy, wz, 1, yaw);
        obstacles.push({ x: wx, z: wz, r: 3.6, kind: 'cabin' });
        break;
      }
    }

    for (let k = 0; k < 55; k++) {
      const lx = (rng() - 0.5) * CHUNK, lz = (rng() - 0.5) * CHUNK;
      const wx = ox + lx, wz = oz + lz;
      if ((wx - SPAWN.x) ** 2 + (wz - SPAWN.z) ** 2 < 16 * 16) continue;
      if ((wx - LODGE.x) ** 2 + (wz - LODGE.z) ** 2 < (LODGE.r + 3) ** 2) continue;
      if (trailFactor(wx, wz) > 0.18) continue;      // keep the three runs clear
      // biome decides what's here: forest is common + dense, open is sparse,
      // glaciers are bare ice with only the odd boulder
      const biome = biomeAt(wx, wz);
      let isTree;
      if (biome === 'glacier') {
        if (rng() > 0.09) continue;                  // open ice — mostly clear
        isTree = false;
      } else {
        const forest = biome === 'forest';
        isTree = rng() < (forest ? 0.9 : 0.5);
        const dens = isTree ? (forest ? 0.92 : 0.32) : (forest ? 0.22 : 0.34);
        if (rng() > dens) continue;
      }
      terrainNormal(wx, wz, n);
      if (n.y < 0.62) continue;
      const wy = terrainHeight(wx, wz);
      const yaw = rng() * Math.PI * 2;
      if (NATURE.ready) {
        // the user's nature pack: pines mostly, willows/dead trees as accents
        if (isTree) {
          const v = rng();
          const tpl = v < 0.42 ? NATURE.pine2 : v < 0.74 ? NATURE.pine5
                    : v < 0.88 ? NATURE.common4 : v < 0.96 ? NATURE.willow1 : NATURE.willowDead;
          const s = 2.4 + rng() * 2.2;
          this._stamp(verts, cols, nors, tpl, wx, wy, wz, s, yaw);
          obstacles.push({ x: wx, z: wz, r: 0.17 * s, kind: 'tree' }); // trunk only
        } else {
          const v = rng();
          if (v < 0.72) { // rocks
            const tpl = v < 0.36 ? NATURE.rock3 : NATURE.rock6;
            const s = 1.4 + rng() * 2.0;
            this._stamp(verts, cols, nors, tpl, wx, wy, wz, s, yaw);
            obstacles.push({ x: wx, z: wz, r: 0.42 * s, kind: 'rock' });
          } else if (v < 0.88) {
            const s = 1.5 + rng() * 0.9;
            this._stamp(verts, cols, nors, NATURE.stump, wx, wy, wz, s, yaw);
            obstacles.push({ x: wx, z: wz, r: 0.5 * s, kind: 'rock' });
          } else {
            const s = 1.5 + rng() * 0.9;
            this._stamp(verts, cols, nors, NATURE.log, wx, wy, wz, s, yaw);
            obstacles.push({ x: wx, z: wz, r: 0.85 * s, kind: 'rock' });
          }
        }
      } else if (isTree) {
        const s = 0.9 + rng() * 1.5;
        this._stamp(verts, cols, nors, TEMPLATES.trunk, wx, wy, wz, s, yaw);
        this._stamp(verts, cols, nors, TEMPLATES.tier1, wx, wy, wz, s, yaw);
        this._stamp(verts, cols, nors, TEMPLATES.tier2, wx, wy, wz, s, yaw + 0.5);
        this._stamp(verts, cols, nors, TEMPLATES.tier3, wx, wy, wz, s, yaw + 1.1);
        if (rng() < 0.7) this._stamp(verts, cols, nors, TEMPLATES.cap, wx, wy, wz, s, yaw);
        obstacles.push({ x: wx, z: wz, r: 0.26 * s, kind: 'tree' }); // trunk only
      } else {
        const s = 0.7 + rng() * 1.6;
        this._stamp(verts, cols, nors, TEMPLATES.rock, wx, wy, wz, s, yaw, 0.75);
        obstacles.push({ x: wx, z: wz, r: 0.7 * s, kind: 'rock' });
      }
    }

    let deco = null;
    if (verts.length) {
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      dg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      dg.setAttribute('normal', new THREE.Float32BufferAttribute(nors, 3)); // smooth template normals
      deco = new THREE.Mesh(dg, this.decoMat);
      this.scene.add(deco);
    }

    let boost = null;
    if (bverts.length) {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.Float32BufferAttribute(bverts, 3));
      bg.setAttribute('color', new THREE.Float32BufferAttribute(bcols, 3));
      bg.setAttribute('normal', new THREE.Float32BufferAttribute(bnors, 3));
      boost = new THREE.Mesh(bg, this.boostMat);
      this.scene.add(boost);
    }

    this.chunks.set(`${cx},${cz}`, { ground, deco, boost, obstacles, boosters });
  }

  _stamp(verts, cols, nors, tpl, wx, wy, wz, s, yaw, sy = 1) {
    const p = tpl.pos, nrm = tpl.nor, c = tpl.color, pv = tpl.col; // pv: per-vertex colors
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    for (let i = 0; i < p.length; i += 3) {
      const x0 = p[i] * s, y0 = (p[i + 1] + tpl.y) * s * sy, z0 = (p[i + 2] + (tpl.zOff || 0)) * s;
      verts.push(wx + x0 * cosY + z0 * sinY, wy + y0, wz - x0 * sinY + z0 * cosY);
      // rotate the template's smooth normal by the same yaw
      const nx = nrm[i], ny = nrm[i + 1], nz = nrm[i + 2];
      nors.push(nx * cosY + nz * sinY, ny, -nx * sinY + nz * cosY);
      const sh = 0.95 + ((i * 7) % 13) / 13 * 0.05;
      if (pv) cols.push(pv[i] * sh, pv[i + 1] * sh, pv[i + 2] * sh);
      else cols.push(c[0] * sh, c[1] * sh, c[2] * sh);
    }
  }
}
