// Keyboard + pointer-lock mouse input.
export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.pressed = new Set();   // edge-triggered, consumed once
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.camYaw = 0;            // written by the camera each frame (walk-mode reference)
    this.locked = false;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('mousedown', (e) => {
      if (this.locked && e.button === 0) this.pressed.add('Mouse0'); // throw etc.
    });
    this.canvas = canvas;
  }

  requestLock() {
    try {
      const p = this.canvas.requestPointerLock?.();
      p?.catch?.(() => {});
    } catch { /* pointer lock unavailable (e.g. headless) — mouse look disabled */ }
  }

  down(code) { return this.keys.has(code); }
  axis(neg, pos) { return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0); }
  consume(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }
  takeMouse() {
    const dx = this.mouseDX, dy = this.mouseDY;
    this.mouseDX = 0; this.mouseDY = 0;
    return [dx, dy];
  }
  endFrame() { this.pressed.clear(); }
}
