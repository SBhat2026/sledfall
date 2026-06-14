// SLEDFALL — entry point.
import * as THREE from 'three';
import { Terrain } from './js/terrain.js';
import { Player } from './js/player.js';
import { Input } from './js/input.js';
import { ChaseCam } from './js/camera.js';
import { SnowSpray, Snowfall, Trail } from './js/particles.js';
import { GameAudio } from './js/audio.js';
import { Hud } from './js/hud.js';
import { Shop, SLEDS } from './js/shop.js';
import { SPAWN, terrainHeight, LODGE } from './js/terrain.js';
import { createSled, CHARACTER_IDS, CHARACTERS } from './js/character.js';
import { Snowballs } from './js/snowball.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // soft, clean highlights
renderer.toneMappingExposure = 1.12;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9e6f8);
scene.fog = new THREE.Fog(0xc9e6f8, 170, 1150); // misty far peaks

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 4000);

// lighting: bright cool sky, warm low alpine sun — no shadow maps (blob shadow)
const hemi = new THREE.HemisphereLight(0xeaf4ff, 0xb8c8dc, 1.25);
const sun = new THREE.DirectionalLight(0xfff0d2, 1.45);     // warmer, stronger key
sun.position.set(-220, 300, -150);
const fill = new THREE.DirectionalLight(0xd2e4ff, 0.32);    // soft bounce from the snow
fill.position.set(180, 120, 200);
scene.add(hemi, sun, fill);

// sun ambience: a glowing disc + warm halo in the sky where the key light is.
// fog is disabled on the sprite so it reads through the misty distance, and it
// sits inside the far plane so it appears in-sky behind the peaks.
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
  return s;
}
{
  const dir = sun.position.clone().normalize();
  const halo = makeSunSprite(1500, [
    [0, 'rgba(255,244,214,0.5)'], [0.4, 'rgba(255,232,180,0.18)'], [1, 'rgba(255,232,180,0)'],
  ]);
  const disc = makeSunSprite(420, [
    [0, 'rgba(255,253,245,1)'], [0.25, 'rgba(255,246,222,0.95)'],
    [0.55, 'rgba(255,236,196,0.35)'], [1, 'rgba(255,236,196,0)'],
  ]);
  halo.position.copy(dir).multiplyScalar(2600);
  disc.position.copy(dir).multiplyScalar(2600);
  scene.add(halo, disc);
}

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
const cam = new ChaseCam(camera, terrain, input);
const spray = new SnowSpray(scene);
const snowfall = new Snowfall(scene);
const trail = new Trail(scene);
const snowballs = new Snowballs(scene, terrain);

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

  // snowball throw: click while walking, aimed where the camera looks
  if (input.consume('Mouse0') && player.state === 'walk' && !shop.open) {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    if (dir.y < -0.1) dir.y = -0.1;
    dir.normalize();
    const origin = player.pos.clone()
      .add(new THREE.Vector3(0, 1.05, 0))
      .addScaledVector(dir, 0.5);
    snowballs.throw(origin, dir);
  }

  cam.update(player, dt);
  spray.update(dt, player);
  snowfall.update(dt, camera.position);
  trail.update(dt, player, terrain);
  snowballs.update(dt);
  hud.update(dt, player, terrain);
  // cabin storefront proximity: show the prompt and enable F to enter the shop
  nearLodge = Math.hypot(player.pos.x - LODGE.x, player.pos.z - LODGE.z) < 13;
  if (nearLodge && !shop.open) hud.prompt('<b>F</b> — Sled Shop · pick one off the wall');
  input.endFrame();

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
