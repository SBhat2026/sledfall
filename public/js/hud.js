// DOM HUD: speed, score, trick popups, prompts, crash messages, lift fade,
// and a heading-up minimap of the runs.
import { runCentersAt, LODGE } from './terrain.js';

const MAP_RANGE = 200; // metres shown from centre to edge of the minimap

export class Hud {
  constructor() {
    this.elSpeed = document.querySelector('#speed .num');
    this.elScore = document.getElementById('scoreNum');
    this.elAlt = document.getElementById('altNum');
    this.elTrick = document.getElementById('trick');
    this.elTrickName = document.getElementById('trickName');
    this.elTrickPts = document.getElementById('trickPts');
    this.elPrompt = document.getElementById('prompt');
    this.elMsg = document.getElementById('msg');
    this.elHelp = document.getElementById('help');
    this.elFade = document.getElementById('fade');
    this.elVig = document.getElementById('vig');
    this.map = document.getElementById('minimap');
    this.mapCtx = this.map ? this.map.getContext('2d') : null;
    this.trickTimer = 0;
    this.msgTimer = 0;
  }

  // heading-up minimap: the three runs as ribbons, the lodge + respawn marker,
  // and the player as a bright arrow at the centre always pointing "up".
  drawMap(player) {
    const ctx = this.mapCtx;
    if (!ctx) return;
    const W = this.map.width, cx = W / 2, cy = W / 2;
    const sc = (W / 2 - 8) / MAP_RANGE;
    const px = player.pos.x, pz = player.pos.z, h = player.heading;
    const sinH = Math.sin(h), cosH = Math.cos(h);
    // world (x,z) → screen, rotated so the player's heading faces up
    const proj = (x, z) => {
      const rx = x - px, rz = z - pz;
      const fwd = rx * sinH + rz * cosH;       // along travel
      const rgt = rx * cosH - rz * sinH;       // to the right
      return [cx + rgt * sc, cy - fwd * sc];
    };

    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, W / 2 - 3, 0, Math.PI * 2); ctx.clip();

    // run ribbons
    ctx.lineWidth = 3.4; ctx.lineCap = 'round';
    const runs = [];
    for (let z = pz - MAP_RANGE; z <= pz + MAP_RANGE; z += 14) runs.push(z);
    const xsAt = z => runCentersAt(z);
    for (let r = 0; r < 3; r++) {
      ctx.strokeStyle = r === 1 ? 'rgba(143,208,255,.95)' : 'rgba(143,208,255,.5)';
      ctx.beginPath();
      let first = true;
      for (const z of runs) {
        const [sx, sy] = proj(xsAt(z)[r], z);
        if (first) { ctx.moveTo(sx, sy); first = false; } else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }

    // lodge marker
    const [lx, ly] = proj(LODGE.x, LODGE.z);
    ctx.fillStyle = '#ffd34d';
    ctx.fillRect(lx - 3, ly - 3, 6, 6);

    // respawn point
    if (player.respawnPoint) {
      const [rx, ry] = proj(player.respawnPoint.x, player.respawnPoint.z);
      ctx.strokeStyle = '#7CFC9A'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(rx, ry, 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // player arrow (always centre, pointing up)
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7);
    ctx.lineTo(cx - 5, cy + 6);
    ctx.lineTo(cx + 5, cy + 6);
    ctx.closePath();
    ctx.fill();
  }

  toggleHelp() {
    this.elHelp.style.display = this.elHelp.style.display === 'none' ? '' : 'none';
  }

  trick(name, pts) {
    this.elTrickName.textContent = name;
    this.elTrickPts.textContent = pts ? `+${pts}` : '';
    this.elTrick.style.opacity = 1;
    this.trickTimer = 1.6;
  }

  crash(label) {
    this.elMsg.textContent = label;
    this.elMsg.style.opacity = 1;
    this.msgTimer = 2.2;
  }

  clearMsg() {
    this.elMsg.style.opacity = 0;
  }

  prompt(text) {
    if (text) {
      this.elPrompt.innerHTML = text;
      this.elPrompt.style.display = 'block';
    } else {
      this.elPrompt.style.display = 'none';
    }
  }

  fadeLift(mid) {
    this.elFade.style.opacity = 1;
    setTimeout(() => {
      mid();
      setTimeout(() => { this.elFade.style.opacity = 0; }, 250);
    }, 520);
  }

  update(dt, player, terrain) {
    // speed = actual distance covered per second (smoothed), in m/s
    if (!this._lastPos) this._lastPos = player.pos.clone();
    const step = player.pos.distanceTo(this._lastPos);
    this._lastPos.copy(player.pos);
    let inst = dt > 0 ? step / dt : 0;
    if (inst > 90) inst = this._spd ?? 0; // ignore teleports (T / respawn)
    this._spd = (this._spd ?? 0) + (inst - (this._spd ?? 0)) * Math.min(1, dt * 8);
    this.elSpeed.textContent = Math.round(this._spd);
    // speed vignette: edges darken as the run gets fast
    this.elVig.style.opacity = Math.min(1, Math.max(0, (this._spd - 16) / 18)).toFixed(2);
    this.elScore.textContent = player.score;
    this.elAlt.textContent = Math.max(0, Math.round((this.spawnY ?? 0) - player.pos.y));

    if (this.trickTimer > 0) {
      this.trickTimer -= dt;
      if (this.trickTimer <= 0) this.elTrick.style.opacity = 0;
    }
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.clearMsg();
    }

    // contextual prompts
    if (player.state === 'walk') {
      this.prompt('<b>E</b> hop on · <b>B</b> belly slide · hold <b>LMB</b> aim snowball · <b>Q</b> roll boulder · <b>G</b> kicker');
    } else if ((player.state === 'sled' || player.state === 'belly') && player.planarSpeed() < 1.5 && player.grounded) {
      this.prompt('<b>W</b> — push off · <b>E</b> — walk · <b>B</b> — ' + (player.state === 'belly' ? 'stand up' : 'belly slide'));
    } else {
      this.prompt(null);
    }

    this.drawMap(player);
  }
}
