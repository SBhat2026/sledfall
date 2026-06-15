// DOM HUD: speed, score, trick popups, prompts, crash messages, lift fade.
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
    this.trickTimer = 0;
    this.msgTimer = 0;
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
      this.prompt('<b>E</b> hop on · hold <b>LMB</b> aim snowball · <b>Q</b> roll boulder · <b>G</b> kicker');
    } else if (player.state === 'sled' && player.planarSpeed() < 1.5 && player.grounded) {
      this.prompt('<b>W</b> — push off · <b>E</b> — get off and walk · <b>B</b> — sled shop');
    } else {
      this.prompt(null);
    }
  }
}
