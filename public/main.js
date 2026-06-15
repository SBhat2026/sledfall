// SLEDFALL — entry point.
import * as THREE from 'three';
import { Terrain } from './js/terrain.js';
import { Player } from './js/player.js';
import { Input } from './js/input.js';
import { ChaseCam } from './js/camera.js';
import { SnowSpray, Snowfall, Trail, Sparkle } from './js/particles.js';
import { GameAudio } from './js/audio.js';
import { Hud } from './js/hud.js';
import { Shop, SLEDS } from './js/shop.js';
import { SPAWN, terrainHeight, LODGE, trailX } from './js/terrain.js';
import { createSled, CHARACTER_IDS, CHARACTERS } from './js/character.js';
import { Snowballs } from './js/snowball.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // soft, clean highlights
renderer.toneMappingExposure = 1.12;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfeef8);
scene.fog = new THREE.Fog(0xdfeef8, 220, 1300); // distance fades into the sky

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 4000);

// lighting: bright cool sky, warm low alpine sun — no shadow maps (blob shadow)
const hemi = new THREE.HemisphereLight(0xeaf4ff, 0xb8c8dc, 1.25);
const sun = new THREE.DirectionalLight(0xfff0d2, 1.45);     // warmer, stronger key
sun.position.set(-220, 300, -150);
const fill = new THREE.DirectionalLight(0xd2e4ff, 0.32);    // soft bounce from the snow
fill.position.set(180, 120, 200);
scene.add(hemi, sun, fill);

// skyRig: a gradient sky dome + a glowing sun disc/halo. it rides with the
// camera so the sky sits at infinity. fog off so it reads cleanly.
const skyRig = new THREE.Group();
scene.add(skyRig);
const sunDir = sun.position.clone().normalize();
{
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x3f86d4) },
      horizon: { value: new THREE.Color(0xeaf3fb) },
      sunDir: { value: sunDir.clone() },
      sunCol: { value: new THREE.Color(0xfff2d6) },
    },
    vertexShader: `varying vec3 vDir;
      void main(){ vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 top; uniform vec3 horizon;
      uniform vec3 sunDir; uniform vec3 sunCol;
      void main(){
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(horizon, top, pow(h, 0.78));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += sunCol * (pow(s, 8.0) * 0.5 + pow(s, 220.0) * 1.5); // soft glow + bright sun
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  skyRig.add(new THREE.Mesh(new THREE.SphereGeometry(3000, 24, 16), skyMat));
}
// sun disc + warm halo sprites layered over the dome's bright spot for bloom
function makeSunSprite(scale, stops) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [stop, color] of stops) grd.addColorStop(stop, color);
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const mat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, fog: false,
  });
  const s = new THREE.Sprite(mat); s.scale.setScalar(scale);
  s.position.copy(sunDir).multiplyScalar(2500);
  return s;
}
skyRig.add(
  makeSunSprite(1500, [[0, 'rgba(255,244,214,0.45)'], [0.4, 'rgba(255,232,180,0.16)'], [1, 'rgba(255,232,180,0)']]),
  makeSunSprite(440, [[0, 'rgba(255,253,245,1)'], [0.25, 'rgba(255,246,222,0.95)'], [0.55, 'rgba(255,236,196,0.32)'], [1, 'rgba(255,236,196,0)']]),
);

const input = new Input(canvas);
const hud = new Hud();
const audio = new GameAudio();
const terrain = new Terrain(scene);
const player = new Player(scene, terrain, input, hud, audio);
const shop = new Shop(player);
hud.spawnY = terrainHeight(SPAWN.x, SPAWN.z);

// ---- cabin storefront: every buyable sled hangs on the lodge's front wall.
// walk up to the cabin to browse & buy (a hub like Sledding Game by Max).
const lodgeBaseY = LODGE.y - 0.5;
SLEDS.forEach((def, i) => {
  const s = createSled(def.id);
  s.scale.setScalar(0.92);
  s.rotation.z = -Math.PI / 2; // disc stands vertical, face pointing out toward the run
  s.position.set(
    LODGE.x + 5.7,
    lodgeBaseY + 3.4,
    LODGE.z + (i - (SLEDS.length - 1) / 2) * 2.6,
  );
  scene.add(s);
});
// ---- ski-lift: an iconic landmark running up-slope beside the middle run
// near the lodge (cosmetic — towers + cables + a few chairs)
(function buildSkiLift() {
  const grp = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b424b, roughness: 0.7, metalness: 0.3 });
  const cableMat = new THREE.LineBasicMaterial({ color: 0x2a2f36 });
  const chairMat = new THREE.MeshStandardMaterial({ color: 0xcc3b30, roughness: 0.6 });
  const tops = [];
  const H = 9, offset = 30;
  for (let z = LODGE.z + 30; z >= LODGE.z - 360; z -= 48) {
    const x = trailX(z) + offset, gy = terrainHeight(x, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, H, 8), poleMat);
    pole.position.set(x, gy + H / 2, z);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.3, 0.3), poleMat);
    arm.position.set(x, gy + H, z);
    grp.add(pole, arm);
    tops.push(new THREE.Vector3(x, gy + H + 0.15, z));
  }
  for (const dx of [-1.5, 1.5]) {
    const pts = tops.map(p => new THREE.Vector3(p.x + dx, p.y, p.z));
    grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
  }
  for (let i = 0; i < tops.length - 1; i += 2) {
    const a = tops[i], b = tops[i + 1];
    const mx = (a.x + b.x) / 2 - 1.5, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
    const chair = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 1.0), chairMat);
    chair.position.set(mx, my - 1.7, mz);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6), poleMat);
    bar.position.set(mx, my - 0.9, mz);
    grp.add(chair, bar);
  }
  scene.add(grp);
})();

const cam = new ChaseCam(camera, terrain, input);
const spray = new SnowSpray(scene);
const snowfall = new Snowfall(scene);
const sparkle = new Sparkle(scene);
const trail = new Trail(scene);
const snowballs = new Snowballs(scene, terrain);
// rolling boulder smashed → score by size; player run over → ragdoll
snowballs.onScore = (pts) => { player.score += pts; player.onScore?.(); hud.trick('SNOWBALL SMASH!', pts); };
snowballs.onSquash = () => { if (player.state !== 'crash') player._crash('STEAMROLLED!'); };

// ---- snowball aiming: a wind-up + over-the-shoulder arc indicator ----------
const THROW_G = 13.5;
const heldBall = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }));
heldBall.visible = false; scene.add(heldBall);
const ARC_N = 26;
const arcGeo = new THREE.BufferGeometry();
arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_N * 3), 3));
const arc = new THREE.Points(arcGeo, new THREE.PointsMaterial({
  color: 0x9fd0ff, size: 0.2, transparent: true, opacity: 0.95, depthTest: false, sizeAttenuation: true,
}));
arc.frustumCulled = false; arc.visible = false; scene.add(arc);
let aiming = false, charge = 0;

function throwDir() {
  const d = new THREE.Vector3();
  camera.getWorldDirection(d);
  if (d.y < -0.05) d.y = -0.05;
  return d.normalize();
}
function doThrow(c) {
  const dir = throwDir();
  const origin = player.pos.clone().add(new THREE.Vector3(0, 1.1, 0)).addScaledVector(dir, 0.5);
  snowballs.throw(origin, dir, THREE.MathUtils.lerp(12, 26, c));
  audio?.thump?.(0.25);
}
function updateAimVisuals(on, c) {
  heldBall.visible = on;
  arc.visible = on && c > 0.05;
  if (on) {
    const fwd = player.headingDir(new THREE.Vector3());
    heldBall.position.copy(player.pos).add(new THREE.Vector3(0, 1.05, 0)).addScaledVector(fwd, 0.22);
    heldBall.scale.setScalar(0.07 + c * 0.13); // grows as it's packed
  }
  if (arc.visible) {
    const dir = throwDir();
    const v = dir.clone().multiplyScalar(THREE.MathUtils.lerp(12, 26, c)).add(new THREE.Vector3(0, 2.5, 0));
    const p = player.pos.clone().add(new THREE.Vector3(0, 1.1, 0)).addScaledVector(dir, 0.5);
    const a = arcGeo.attributes.position.array;
    for (let k = 0; k < ARC_N; k++) {
      a[k * 3] = p.x; a[k * 3 + 1] = p.y; a[k * 3 + 2] = p.z;
      v.y -= THROW_G * 0.06; p.addScaledVector(v, 0.06);
      const gy = terrain.height(p.x, p.z);
      if (p.y < gy) { for (let j = k + 1; j < ARC_N; j++) { a[j * 3] = p.x; a[j * 3 + 1] = gy; a[j * 3 + 2] = p.z; } break; }
    }
    arcGeo.attributes.position.needsUpdate = true;
  }
}

// debug handle (harmless in production)
window.__dbg = { scene, camera, player, renderer, shop, terrain, cam, snowballs };

// title screen → pointer lock + audio unlock
const title = document.getElementById('title');
let started = false;
let nearLodge = false; // within range of the cabin storefront
title.addEventListener('click', () => {
  started = true;
  title.style.display = 'none';
  audio.start();
  input.requestLock();
});
canvas.addEventListener('click', () => { if (started) input.requestLock(); });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyH') hud.toggleHelp();
  if (e.code === 'KeyC' && started) {
    const ids = CHARACTER_IDS;
    const next = ids[(ids.indexOf(player.characterId) + 1) % ids.length];
    player.setCharacter(next);
    hud.trick('NOW PLAYING: ' + CHARACTERS[next].name.toUpperCase(), 0);
  }
  if (e.code === 'KeyF' && started && (nearLodge || shop.open)) shop.toggle();
  if (e.code === 'KeyB' && started) shop.toggle(); // shortcut, works anywhere
  if (e.code === 'Escape' && shop.open) shop.toggle(false);
  // drop a rolling, growing snowball boulder (on foot)
  if (e.code === 'KeyQ' && started && player.state === 'walk' && !shop.open) {
    const dir = player.headingDir(new THREE.Vector3());
    const origin = player.pos.clone().add(new THREE.Vector3(0, 0.4, 0)).addScaledVector(dir, 1.2);
    snowballs.dropRoller(origin, dir);
    hud.trick('SNOWBALL ROLLING!', 0);
  }
});

// fixed-timestep physics, render at display rate
const STEP = 1 / 120;
let acc = 0;
let last = performance.now();
let wasCrash = false;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (!started) { renderer.render(scene, camera); return; }

  acc += dt;
  while (acc >= STEP) {
    if (!shop.open) player.update(STEP);
    acc -= STEP;
  }
  terrain.update(player.pos.x, player.pos.z); // stream chunks around the player

  // crash camera punch + landing thump
  if (player.state === 'crash' && !wasCrash) cam.impulse(1);
  wasCrash = player.state === 'crash';
  if (player.landedImpact > 6) cam.impulse(Math.min(0.6, player.landedImpact / 35));
  player.landedImpact = 0;

  // snowball aiming (on foot): hold LMB to pack + aim with the camera at the
  // shoulder and an arc on screen; release to throw. camera eases back after.
  const canAim = player.state === 'walk' && !shop.open;
  if (canAim && input.mouse0) {
    aiming = true;
    charge = Math.min(1, charge + dt / 0.6); // ~0.6 s to pack the ball
  } else if (aiming) {
    if (canAim && charge > 0.2) doThrow(charge);
    aiming = false; charge = 0;
  }
  cam.setAim(aiming);
  updateAimVisuals(aiming, charge);

  cam.update(player, dt);
  skyRig.position.copy(camera.position); // sky + sun ride at infinity
  spray.update(dt, player);
  snowfall.update(dt, camera.position);
  sparkle.update(dt, camera.position, terrain);
  trail.update(dt, player, terrain);
  snowballs.update(dt, player);
  hud.update(dt, player, terrain);
  // cabin storefront proximity: show the prompt and enable F to enter the shop
  nearLodge = Math.hypot(player.pos.x - LODGE.x, player.pos.z - LODGE.z) < 13;
  if (nearLodge && !shop.open) hud.prompt('<b>F</b> — Sled Shop · pick one off the wall');
  input.endFrame();

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
