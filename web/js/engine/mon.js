// Core Pokemon instance model: creation, stats, and stat modifiers.
import { buildStats, boostMul, accMul } from '../stats.js';

export const STATUS = { brn: '灼伤', par: '麻痹', slp: '睡眠', psn: '中毒', tox: '剧毒', frz: '冰冻' };

// Abilities that double an offensive stat
const HUGE_POWER = new Set(['hugepower', 'purepower']);
// Abilities that set weather on entry
export const WEATHER_SETTERS = {
  drizzle: 'rain', drought: 'sun', sandstream: 'sand', snowwarning: 'snow',
  desolateland: 'sun', primordialsea: 'rain',
};
// Terrain setters
export const TERRAIN_SETTERS = {
  electricsurge: 'electric', grassysurge: 'grassy', psychicsurge: 'psychic', mistysurge: 'misty',
};
// Type immunities granted by abilities
export const ABILITY_IMMUNITY = {
  levitate: ['Ground'],
  flashfire: ['Fire'],
  waterabsorb: ['Water'],
  voltabsorb: ['Electric'],
  sapsipper: ['Grass'],
  motordrive: ['Electric'],
  stormdrain: ['Water'],
  lightningrod: ['Electric'],
  dryskin: ['Water'],
  bulletproof: null, // handled by flags
  soundproof: null,
  wonderguard: 'wonderguard',
  eartheater: ['Ground'],
  wellbakedbody: ['Fire'],
};

// Abilities that change the type of Normal moves
const PIXILATE = { pixilate: 'Fairy', aerilate: 'Flying', refrigerate: 'Ice', galvanize: 'Electric' };

export function createMon(dex, speciesId, cfg = {}) {
  const sp = dex.species[speciesId];
  if (!sp) throw new Error('unknown species ' + speciesId);
  const level = cfg.level || 50;
  const stats = buildStats(sp, { level, nature: cfg.nature, evs: cfg.evs, ivs: cfg.ivs });
  // 游戏里的精灵个体值是随机的，允许直接填真实满血值
  const maxHp = cfg.maxHp ? Math.max(1, Math.min(999, Math.round(cfg.maxHp))) : stats.hp;
  stats.hp = maxHp;
  const mon = {
    speciesId,
    name: cfg.nickname || (dex.zh && dex.zh.species && dex.zh.species[speciesId]) || sp.name,
    types: (cfg.types || sp.types).slice(),
    level,
    baseStats: sp.baseStats,
    stats,
    maxHp,
    hp: cfg.hp !== undefined ? Math.min(cfg.hp, maxHp) : maxHp,
    status: cfg.status || null,
    statusTurns: 0,
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 },
    item: cfg.item || null,
    ability: cfg.ability || defaultAbility(dex, sp),
    nature: cfg.nature || 'hardy',
    moves: (cfg.moves || []).slice(0, 4),
    volatiles: {},
    fainted: false,
    // information tracking for the opponent side
    revealed: cfg.revealed || {},
  };
  if (cfg.hp !== undefined && cfg.hp <= 0) mon.fainted = true;
  return mon;
}

export function defaultAbility(dex, sp) {
  const ab = sp.abilities || {};
  const id = ab['0'] || ab['1'] || ab['H'] || null;
  return id ? id.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

export function isAlive(mon) {
  return mon && !mon.fainted && mon.hp > 0;
}

export function aliveCount(team) {
  return team.filter(isAlive).length;
}

// Current effective stat value including boosts, status, items, abilities, weather.
export function getStat(state, side, mon, stat, opts = {}) {
  let v = mon.stats[stat];
  const ab = mon.ability;
  const item = mon.item;
  const weather = state.field.weather;

  // boosts (crit ignores negative attacker boosts / positive defender boosts -- caller handles)
  if (opts.crit && opts.isDefender) {
    if (stat !== 'hp') v = mon.stats[stat];
  } else {
    v = Math.floor(v * boostMul(mon.boosts[stat] !== undefined ? mon.boosts[stat] : 0));
  }

  if (stat === 'atk') {
    if (HUGE_POWER.has(ab)) v *= 2;
    if (ab === 'guts' && mon.status) v = Math.floor(v * 1.5);
    if (ab === 'hustle') v = Math.floor(v * 1.5);
    if (item === 'choiceband') v = Math.floor(v * 1.5);
    if (ab === 'toxicboost' && (mon.status === 'psn' || mon.status === 'tox')) v = Math.floor(v * 1.5);
    if (ab === 'flareboost' && mon.status === 'brn') v = Math.floor(v * 1.5);
    if (mon.status === 'brn') v = Math.floor(v * 0.5);
  }
  if (stat === 'spa') {
    if (item === 'choicespecs') v = Math.floor(v * 1.5);
    if (ab === 'solarpower' && weather === 'sun') v = Math.floor(v * 1.5);
  }
  if (stat === 'def') {
    if (ab === 'furcoat') v *= 2;
    if (ab === 'marvelscale' && mon.status) v = Math.floor(v * 1.5);
  }
  if (stat === 'spd') {
    if (item === 'assaultvest') v = Math.floor(v * 1.5);
    if (ab === 'icescales') v *= 2;
    if (ab === 'sandforce' && weather === 'sand' && opts.sandBoost) v = Math.floor(v * 1.3);
  }
  if (stat === 'spe') {
    if (item === 'choicescarf') v = Math.floor(v * 1.5);
    // Gen 5 paralysis cuts speed to 25% (Gen 7+ uses 50%).
    if (mon.status === 'par') v = Math.floor(v * 0.25);
    const sw = { swiftswim: 'rain', chlorophyll: 'sun', sandrush: 'sand', slushrush: 'snow' }[ab];
    if (sw && weather === sw) v *= 2;
    if (ab === 'surgesurfer' && state.field.terrain === 'electric') v *= 2;
    if (ab === 'quickfeet' && mon.status) v = Math.floor(v * 1.5);
  }
  return Math.max(1, Math.floor(v));
}

export function speedOf(state, side, mon) {
  return getStat(state, side, mon, 'spe');
}

export function accStage(mon) {
  return accMul(mon.boosts.acc - mon.boosts.eva);
}

// Move type after ability type changes (Pixilate etc.)
export function effectiveMoveType(dex, mon, move) {
  if (!move) return 'Normal';
  const ab = mon.ability;
  if (move.type === 'Normal' && PIXILATE[ab]) return PIXILATE[ab];
  const id = move.id || '';
  if (id.startsWith('hiddenpower')) return move.type;
  return move.type;
}

export function stabMultiplier(mon, moveType, ability) {
  const types = ability === 'protean' || ability === 'libero' ? [moveType] : mon.types;
  if (!types.includes(moveType)) return 1;
  return ability === 'adaptability' ? 2 : 1.5;
}
