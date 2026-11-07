// Stat calculation, Gen 3+ formula.
import { natureMod } from './natures.js';

export function calcHp(base, level, iv = 31, ev = 0) {
  if (base === 1) return 1; // Shedinja
  return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
}

export function calcStat(base, level, iv = 31, ev = 0, nature = 'hardy', stat = 'atk') {
  const raw = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5;
  return Math.floor(raw * natureMod(nature, stat));
}

// Build a full stat block for a mon config.
export function buildStats(species, cfg = {}) {
  const level = cfg.level || 50;
  const ivs = Object.assign({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, cfg.ivs || {});
  // 这个池子里的精灵：个体值全满(31)、努力值每项 85、性格不确定（按中性算）
  const evs = Object.assign({ hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 }, cfg.evs || {});
  const nature = cfg.nature || 'hardy';
  const b = species.baseStats;
  const out = {
    hp: calcHp(b.hp, level, ivs.hp, evs.hp),
    atk: calcStat(b.atk, level, ivs.atk, evs.atk, nature, 'atk'),
    def: calcStat(b.def, level, ivs.def, evs.def, nature, 'def'),
    spa: calcStat(b.spa, level, ivs.spa, evs.spa, nature, 'spa'),
    spd: calcStat(b.spd, level, ivs.spd, evs.spd, nature, 'spd'),
    spe: calcStat(b.spe, level, ivs.spe, evs.spe, nature, 'spe'),
  };
  return out;
}

// Boost multiplier table: -6..+6
const BOOST = [2 / 8, 2 / 7, 2 / 6, 2 / 5, 2 / 4, 2 / 3, 1, 3 / 2, 4 / 2, 5 / 2, 6 / 2, 7 / 2, 8 / 2];
export function boostMul(stage) {
  const s = Math.max(-6, Math.min(6, stage || 0));
  return BOOST[s + 6];
}

// Accuracy / evasion stage multipliers
const ACC = [33 / 100, 36 / 100, 43 / 100, 50 / 100, 60 / 100, 75 / 100, 1, 133 / 100, 166 / 100, 2, 250 / 100, 300 / 100, 350 / 100];
export function accMul(stage) {
  const s = Math.max(-6, Math.min(6, stage || 0));
  return ACC[s + 6];
}
