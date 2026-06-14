// Procedural audio: impact thumps + crash only. Ride loops (wind/carve)
// removed for now per design — sledding itself is silent.
export class GameAudio {
  constructor() {
    this.ctx = null;
  }

  start() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    // shared noise buffer (crash rumble)
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  setRide() {} // no continuous sled sound

  thump(strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.35 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(g).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.2);
  }

  crash() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this.thump(1.4);
    // tumbling noise burst
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.setValueAtTime(1200, t);
    f.frequency.exponentialRampToValueAtTime(180, t + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t); src.stop(t + 0.85);
  }
}
