// Turn-based 3v3 singles simulation (deterministic variant, used for search).
import { damageRange } from '../damage.js';
import { getStat, speedOf, stabMultiplier, effectiveMoveType, isAlive, aliveCount, ABILITY_IMMUNITY, WEATHER_SETTERS, TERRAIN_SETTERS } from './mon.js';

export const other = (s) => (s === 'mine' ? 'theirs' : 'mine');

// PokeMMO random PvP uses a 4-mon team: three are on the field (can rotate for
// free) and one sits on the bench (only enters through a real switch).
export const FIELD_SIZE = 3;

export function newState(myTeam, oppTeam) {
  const mk = (team) => {
    const onField = [];
    for (let i = 0; i < Math.min(FIELD_SIZE, team.length); i++) onField.push(i);
    return { onField, bench: team.length > FIELD_SIZE ? FIELD_SIZE : -1 };
  };
  const m = mk(myTeam), o = mk(oppTeam);
  return {
    mine: myTeam, theirs: oppTeam,
    active: { mine: m.onField[0] || 0, theirs: o.onField[0] || 0 },
    onField: { mine: m.onField, theirs: o.onField },
    bench: { mine: m.bench, theirs: o.bench },
    field: { weather: null, weatherTurns: 0, terrain: null, terrainTurns: 0, turn: 1 },
    sides: {
      mine: { screens: { reflect: 0, lightScreen: 0 }, hazards: { stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0 } },
      theirs: { screens: { reflect: 0, lightScreen: 0 }, hazards: { stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0 } },
    },
    log: [],
  };
}

export function clone(state) {
  return structuredClone(state);
}

export function activeOf(state, side) {
  const idx = state.active[side];
  return state[side][idx];
}

// A fainted field member is replaced for free by the bench mon.
export function promoteBench(state, side) {
  const b = state.bench[side];
  if (b === undefined || b < 0) return -1;
  const mon = state[side][b];
  if (!isAlive(mon)) return -1;
  const alive = state.onField[side].filter((i) => isAlive(state[side][i]));
  if (alive.length >= FIELD_SIZE) return -1;
  state.onField[side].push(b);
  state.bench[side] = -1;
  return b;
}

export function firstAlive(state, side) {
  return state[side].findIndex(isAlive);
}

export function isOver(state) {
  return aliveCount(state.mine) === 0 || aliveCount(state.theirs) === 0;
}

export function winner(state) {
  if (aliveCount(state.theirs) === 0) return 'mine';
  if (aliveCount(state.mine) === 0) return 'theirs';
  return null;
}

// ---------------------------------------------------------------- damage

export function weatherMult(state, moveType) {
  const w = state.field.weather;
  if (w === 'sun') {
    if (moveType === 'Fire') return 1.5;
    if (moveType === 'Water') return 0.5;
  }
  if (w === 'rain') {
    if (moveType === 'Water') return 1.5;
    if (moveType === 'Fire') return 0.5;
  }
  return 1;
}

function abilityBlocks(enemyMon, move, moveType) {
  const ab = enemyMon.ability;
  if (!ab) return false;
  const list = ABILITY_IMMUNITY[ab];
  if (ab === 'wonderguard') return null; // special
  if (Array.isArray(list) && list.includes(moveType)) return true;
  if (ab === 'bulletproof' && move.flags && move.flags.bullet) return true;
  if (ab === 'soundproof' && move.flags && move.flags.sound) return true;
  if (ab === 'overcoat' && move.flags && move.flags.powder) return true;
  return false;
}

export function calcDamage(dex, state, side, moveId, opts = {}) {
  const atkSide = side, defSide = other(side);
  const atk = activeOf(state, atkSide);
  const def = activeOf(state, defSide);
  const move = dex.moves[moveId];
  if (!move || !move.basePower) return { min: 0, max: 0, eff: 1, note: '变化招式' };

  const type = effectiveMoveType(dex, atk, move);
  const category = move.category;

  // ability immunities
  if (abilityBlocks(def, move, type)) {
    return { min: 0, max: 0, eff: 0, note: '特性免疫', immune: true };
  }
  if (def.ability === 'wonderguard') {
    const effCheck = typeEffect(dex, type, def.types);
    if (effCheck <= 1) return { min: 0, max: 0, eff: effCheck, note: '神秘守护', immune: true };
  }
  if (def.item === 'airballoon' && type === 'Ground') {
    return { min: 0, max: 0, eff: 0, note: '气球免疫', immune: true };
  }

  const atkStatKey = category === 'Physical' ? 'atk' : 'spa';
  const defStatKey = category === 'Physical' ? 'def' : 'spd';

  let atkStat = getStat(state, atkSide, atk, atkStatKey);
  let defStat = getStat(state, defSide, def, defStatKey, { crit: opts.crit });

  // Unaware ignores the other side's boosts
  if (def.ability === 'unaware') atkStat = Math.floor(atk.stats[atkStatKey] * (atk.ability && ['hugepower', 'purepower'].includes(atk.ability) ? 2 : 1));
  if (atk.ability === 'unaware') defStat = def.stats[defStatKey];

  // screens
  const screens = state.sides[defSide].screens;
  let screen = false;
  if (!opts.crit && def.ability !== 'infiltrator') {
    if (category === 'Physical' && screens.reflect > 0) screen = true;
    if (category === 'Special' && screens.lightScreen > 0) screen = true;
  }

  const eff = typeEffect(dex, type, def.types);
  if (eff === 0) return { min: 0, max: 0, eff: 0, note: '无效', immune: true };

  // ability damage modifiers
  const ab = atk.ability;
  let otherMul = 1;
  if (ab === 'technician' && move.basePower <= 60) otherMul *= 1.5;
  if (ab === 'toughclaws' && move.flags && move.flags.contact) otherMul *= 1.3;
  if (ab === 'strongjaw' && move.flags && move.flags.bite) otherMul *= 1.5;
  if (ab === 'ironfist' && move.flags && move.flags.punch) otherMul *= 1.2;
  if (ab === 'sharpness' && move.flags && move.flags.slicing) otherMul *= 1.5;
  if (ab === 'sheerforce' && move.secondary) otherMul *= 1.3;
  if (ab === 'tintedlens' && eff < 1) otherMul *= 2;
  if ((ab === 'solidrock' || ab === 'filter' || ab === 'prismarmor') && eff > 1) otherMul *= 0.75;
  if (ab === 'punkrock' && move.flags && move.flags.sound) otherMul *= 1.3;
  if (ab === 'steelworker' && type === 'Steel') otherMul *= 1.5;
  if (ab === 'dragonsmaw' && type === 'Dragon') otherMul *= 1.5;
  if (ab === 'transistor' && type === 'Electric') otherMul *= 1.3;
  if (ab === 'rockypayload' && type === 'Rock') otherMul *= 1.5;
  if (ab === 'waterbubble' && type === 'Water') otherMul *= 2;
  if (ab === 'stakeout' && opts.switchedIn) otherMul *= 2;
  if (ab === 'analytic' && opts.movedLast) otherMul *= 1.3;
  if (ab === 'reckless' && (move.recoil || move.hasCrashDamage)) otherMul *= 1.2;
  if (ab === 'ironfist') otherMul *= 1.0;

  // defender abilities
  const dab = def.ability;
  if (dab === 'thickfat' && (type === 'Fire' || type === 'Ice')) otherMul *= 0.5;
  if (dab === 'heatproof' && type === 'Fire') otherMul *= 0.5;
  if (dab === 'waterbubble' && type === 'Fire') otherMul *= 0.5;
  if (dab === 'fluffy' && move.flags && move.flags.contact) otherMul *= 0.5;
  if (dab === 'fluffy' && type === 'Fire') otherMul *= 2;
  if ((dab === 'multiscale' || dab === 'shadowshield') && def.hp === def.maxHp) otherMul *= 0.5;
  if (dab === 'icescales' && category === 'Special') otherMul *= 0.5;

  // items
  if (atk.item === 'lifeorb') otherMul *= 1.3;
  if (atk.item === 'expertbelt' && eff > 1) otherMul *= 1.2;
  if (atk.item === 'choiceband' && category === 'Physical') otherMul *= 1.0; // already in stat
  if (atk.item && atk.item.endsWith('plate') && type === atk.item.replace('plate', '')) otherMul *= 1.2;

  const isStab = stabMultiplier(atk, type, ab);
  const mods = {
    adaptability: ab === 'adaptability',
    weatherMul: weatherMult(state, type),
    crit: !!opts.crit,
    burned: atk.status === 'brn',
    screen,
    otherMul,
    spread: false,
  };

  const r = damageRange({
    level: atk.level,
    power: move.basePower,
    atkStat, defStat,
    moveType: type,
    moveCategory: category,
    defTypes: def.types,
    attackerTypes: atk.types,
    chart: dex.typechart,
    mods,
  });

  // STAB applied inside damageRange uses attackerTypes; recompute if adaptivity handled
  return {
    min: r.min,
    max: r.max,
    eff,
    type,
    category,
    note: '',
    stab: isStab,
  };
}

export function typeEffect(dex, type, defTypes) {
  let m = 1;
  const row = dex.typechart && dex.typechart[type];
  for (const d of defTypes) {
    const v = row && Object.prototype.hasOwnProperty.call(row, d) ? row[d] : 1;
    m *= v;
  }
  return m;
}

// ---------------------------------------------------------------- switching

export function applyHazards(dex, state, side, mon) {
  const hz = state.sides[side].hazards;
  const log = [];
  if (mon.item === 'heavydutyboots') return log;
  if (hz.stealthrock) {
    const eff = typeEffect(dex, 'Rock', mon.types);
    const dmg = Math.max(1, Math.floor(mon.maxHp * eff / 8));
    damageMon(mon, dmg);
    log.push(`隐形岩造成 ${dmg} 伤害`);
  }
  if (hz.spikes) {
    const frac = [0, 8, 6, 4][Math.min(3, hz.spikes)];
    const dmg = Math.max(1, Math.floor(mon.maxHp / frac));
    damageMon(mon, dmg);
    log.push(`撒菱造成 ${dmg} 伤害`);
  }
  if (hz.stickyweb) {
    mon.boosts.spe = Math.max(-6, mon.boosts.spe - 1);
    log.push('黏黏网：速度下降');
  }
  return log;
}

export function damageMon(mon, amount) {
  mon.hp = Math.max(0, mon.hp - Math.max(0, Math.floor(amount)));
  if (mon.hp <= 0) mon.fainted = true;
}

export function healMon(mon, amount) {
  if (mon.fainted) return;
  mon.hp = Math.min(mon.maxHp, mon.hp + Math.max(0, Math.floor(amount)));
}

export function switchIn(dex, state, side, idx) {
  const mon = state[side][idx];
  if (!mon || mon.fainted) return [];
  state.active[side] = idx;
  const log = applyHazards(dex, state, side, mon);
  // ability on entry
  const ab = mon.ability;
  const foeSide = other(side);
  const foe = activeOf(state, foeSide);
  if (ab === 'intimidate' && foe && isAlive(foe) && foe.ability !== 'innerfocus' && foe.ability !== 'oblivious' && foe.ability !== 'scrappy') {
    foe.boosts.atk = Math.max(-6, foe.boosts.atk - 1);
    log.push(`${mon.name} 威吓：对手攻击下降`);
    if (foe.ability === 'defiant' || foe.ability === 'competitive') {
      foe.boosts[foe.ability === 'defiant' ? 'atk' : 'spa'] = Math.min(6, foe.boosts[foe.ability === 'defiant' ? 'atk' : 'spa'] + 2);
      log.push(`对手 ${foe.ability === 'defiant' ? '不服输' : '好胜'}：能力提升`);
    }
  }
  if (WEATHER_SETTERS[ab]) {
    const w = WEATHER_SETTERS[ab];
    if (state.field.weather !== w) {
      state.field.weather = w;
      state.field.weatherTurns = 5;
      log.push(`${mon.name} 特性：天气变为${({ rain: '下雨', sun: '晴天', sand: '沙暴', snow: '下雪' })[w]}`);
    }
  }
  if (TERRAIN_SETTERS[ab]) {
    state.field.terrain = TERRAIN_SETTERS[ab];
    state.field.terrainTurns = 5;
  }
  if (ab === 'regenerator' && state[side].some((m) => m !== mon && m._switchedOut)) {
    healMon(mon, Math.floor(mon.maxHp / 3));
  }
  mon._switchedOut = false;
  if (mon.fainted) {
    log.push(`${mon.name} 倒下`);
  }
  return log;
}
