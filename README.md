# SLEDFALL

Open-mountain arcade sledding game. Original code + original primitive-built assets, inspired by the physics-sledding genre. Runs entirely on a localhost server.

## Run

```sh
cd ~/sledding-game
npm start
# → http://localhost:3000
```

## Controls (Mac)

| Key | Action |
| --- | --- |
| `A`/`D` or `←`/`→` | Steer (lean) · spin in air |
| `W` or `↑` | Push off / tuck · frontflip in air |
| `S` or `↓` | Brake (drag feet) · backflip in air |
| `Shift` | Drift (break lateral grip) |
| `Space` | Hop |
| Mouse | Look (click to capture pointer, `Esc` releases) |
| `E` | Get on / off the sled (when slow) |
| `R` | Reset upright at current spot |
| `Enter` | Ride lift back to summit (at the base station) |
| `H` | Toggle help |

## Game loop

Summit → carve down ~1.5 km of open mountain (kickers, moguls, banked walls, trees, rocks) → hit jumps for flip/spin score → reach the base run-out → ride the lift back up. Crashing tumbles you off the sled for ~2.4 s, then you're back on where you stopped — momentum loss is the only penalty.

## Physics (custom, no engine)

- Analytic heightfield terrain — physics samples the height function directly, the mesh is just a view of it.
- Slope-projected gravity drives acceleration (no engine force); quadratic drag sets terminal ≈ 130 km/h.
- Lateral-velocity damping = grip; drift lowers it. Carve gently redirects velocity toward heading.
- Speed-proportional steering (weight shift, not car steering).
- Airborne: free flip/spin tricks; landing checks impact speed + orientation — too hard or too sideways = ragdoll tumble.
- Camera: chase with lag, speed-driven FOV (62→88°), lean tilt, terrain chatter shake, snow-clip avoidance.
- Procedural audio (wind ∝ speed, carve hiss, crash thumps) — no sample files.
