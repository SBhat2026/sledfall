// Sled shop: spend trick points on new sleds. Owned/equipped/points persist
// in localStorage.
const SAVE_KEY = 'sledfall-save-v1';

export const SLEDS = [
  { id: 'classic', name: 'Classic Saucer', price: 0,
    desc: 'Trusty blue disc. Does everything fine.',
    stats: { drag: 1, grip: 1, steer: 1, flip: 1 } },
  { id: 'crimson', name: 'Crimson Racer', price: 400,
    desc: 'Freshly waxed base. Noticeably faster.',
    stats: { drag: 0.85, grip: 1, steer: 1.1, flip: 1 } },
  { id: 'ice', name: 'Ice Runner', price: 1000,
    desc: 'Barely any grip. For drift addicts.',
    stats: { drag: 0.8, grip: 0.55, steer: 1.15, flip: 1 } },
  { id: 'carbon', name: 'Carbon Comet', price: 2200,
    desc: 'Featherweight. Whippy in the air.',
    stats: { drag: 0.7, grip: 1.05, steer: 1.25, flip: 1.2 } },
  { id: 'royal', name: 'Royal Sleigh', price: 5000,
    desc: 'Gold-plated everything. The full package.',
    stats: { drag: 0.62, grip: 1.15, steer: 1.3, flip: 1.3 } },
];

// stat bars shown in the UI: label + 0..1 fill derived from stats
function bars(stats) {
  return [
    ['SPD', (1 / stats.drag - 0.9) / 0.75],
    ['DRIFT', (1.55 - stats.grip) / 1.1],
    ['TURN', (stats.steer - 0.9) / 0.5],
    ['AIR', (stats.flip - 0.9) / 0.5],
  ].map(([k, v]) => [k, Math.max(0.08, Math.min(1, v))]);
}

export class Shop {
  constructor(player) {
    this.player = player;
    this.open = false;
    this.el = document.getElementById('shop');
    this.elPoints = document.getElementById('shopPoints');
    this.elCards = document.getElementById('shopCards');

    const save = this._load();
    this.owned = new Set(save.owned ?? ['classic']);
    this.equipped = save.equipped ?? 'classic';
    if (!this.owned.has(this.equipped)) this.equipped = 'classic';
    player.score = save.points ?? 0;
    player.onScore = () => this.save();

    this._applyEquipped();
    this._render();

    document.getElementById('shopClose').addEventListener('click', () => this.toggle(false));
    window.addEventListener('beforeunload', () => this.save());
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY)) ?? {}; }
    catch { return {}; }
  }

  save() {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      points: this.player.score,
      owned: [...this.owned],
      equipped: this.equipped,
    }));
  }

  toggle(force) {
    this.open = force ?? !this.open;
    this.el.style.display = this.open ? 'flex' : 'none';
    if (this.open) {
      document.exitPointerLock?.();
      this._render();
    }
  }

  _applyEquipped() {
    const def = SLEDS.find(s => s.id === this.equipped) ?? SLEDS[0];
    this.player.setSled(def);
  }

  _onCard(id) {
    const def = SLEDS.find(s => s.id === id);
    if (this.owned.has(id)) {
      this.equipped = id;
      this._applyEquipped();
    } else if (this.player.score >= def.price) {
      this.player.score -= def.price;
      this.owned.add(id);
      this.equipped = id;
      this._applyEquipped();
    } else {
      return; // can't afford
    }
    this.save();
    this._render();
  }

  _render() {
    this.elPoints.textContent = this.player.score;
    this.elCards.innerHTML = '';
    for (const s of SLEDS) {
      const owned = this.owned.has(s.id);
      const equipped = this.equipped === s.id;
      const affordable = this.player.score >= s.price;

      const card = document.createElement('div');
      card.className = 'shop-card' + (equipped ? ' equipped' : '') + (!owned && !affordable ? ' locked' : '');
      const barHtml = bars(s.stats).map(([k, v]) =>
        `<div class="bar"><span>${k}</span><div class="track"><div class="fill" style="width:${Math.round(v * 100)}%"></div></div></div>`
      ).join('');
      const action = equipped ? 'EQUIPPED' : owned ? 'EQUIP' : `${s.price} PTS`;
      card.innerHTML = `
        <div class="swatch swatch-${s.id}"></div>
        <h3>${s.name}</h3>
        <p>${s.desc}</p>
        ${barHtml}
        <div class="action">${action}</div>`;
      card.addEventListener('click', () => this._onCard(s.id));
      this.elCards.appendChild(card);
    }
  }
}
