// Move execution and turn resolution.

// The dex is module-level so that battle states stay plain data (safe to clone).
let DEX = null;
export function setDex(d) { DEX = d; }
import { calcDamage, typeEffect, activeOf, other, damageMon, healMon, switchIn, isOver, clone, promoteBench } from './battle.js';
import { getStat, speedOf, isAlive, effectiveMoveType, aliveCount } from './mon.js';

const FIXED = { seismictoss: 'level', nightshade: 'level', dragonrage: 40, sonicboom: 20, superfang: 'half', naturesmadness: 'half', finalgambit: 'self', endeavor: 'endeavor', counter: 'counter', mirrorcoat: 'counter' };
const OHKO = new Set(['fissure', 'horndrill', 'guillotine', 'sheercold']);
const SELF_SWITCH = new Set(['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport', 'batonpass', 'shedtail']);
const FORCE_SWITCH = new Set(['roar', 'whirlwind', 'dragontail', 'circlethrow']);
const RECOVER = new Set(['recover', 'roost', 'slackoff', 'softboiled', 'milkdrink', 'healorder', 'shoreup', 'synthesis', 'moonlight', 'morningsun', 'junglehealing', 'lifedew', 'wish']);
const SCREEN = { reflect: 'reflect', lightscreen: 'lightScreen', auroraveil: 'auroraveil' };
const HAZARD = { stealthrock: 'stealthrock', spikes: 'spikes', toxicspikes: 'toxicspikes', stickyweb: 'stickyweb' };
const WEATHER_ZH = { raindance: '下雨', sunnyday: '大晴天', sandstorm: '沙暴', hail: '冰雹', snow: '下雪', harshsunshine: '日照强烈', heavyrain: '大雨', strongwinds: '乱流' };
const STATUS_ZH = { par: '麻痹', brn: '灼伤', slp: '睡眠', psn: '中毒', tox: '剧毒', frz: '冰冻' };

// 中文名（招式/精灵），日志用
export function moveZH(m) {
  return (DEX && DEX.zh && DEX.zh.moves && DEX.zh.moves[m.id]) || m.name;
}

export function canAct(mon) {
  if (!isAlive(mon)) return false;
  if (mon.volatiles.flinch) return false;
  return true;
}

// Rotation: every mon currently on the field may attack (free swap, the one that
// steps in both attacks and takes the incoming hit). The bench mon can only be
// brought in with a real switch, which costs the turn.
export function legalActions(state, side) {
  const out = [];
  const field = state.onField[side] || [];
  for (const idx of field) {
    const mon = state[side][idx];
    if (!isAlive(mon)) continue;
    const v = mon.volatiles || {};
    let usable = [];
    mon.moves.forEach((mv, i) => {
      if (!mv) return;
      if (v.taunt > 0 && isStatusMove(state, mv)) return;
      if (v.disable && v.disable.move === mv) return;
      if (mon._choiceLock && mon._choiceLock !== mv) return;
      usable.push({ type: 'move', mon: idx, index: i, moveId: mv });
    });
    if (v.encore) {
      const i = mon.moves.indexOf(v.encore.move);
      if (i >= 0) usable = [{ type: 'move', mon: idx, index: i, moveId: v.encore.move }];
    }
    if (mon._choiceLock) {
      const i = mon.moves.indexOf(mon._choiceLock);
      if (i >= 0) usable = [{ type: 'move', mon: idx, index: i, moveId: mon._choiceLock }];
    }
    if (!usable.length) usable.push({ type: 'move', mon: idx, index: -1, moveId: 'struggle' });
    out.push(...usable);
  }
  const b = state.bench[side];
  if (b !== undefined && b >= 0 && isAlive(state[side][b])) {
    out.push({ type: 'switch', mon: b, index: b });
  }
  return out;
}

function isStatusMove(state, moveId) {
  const m = DEX ? DEX.moves[moveId] : null;
  return !m || m.category === 'Status';
}

function hasScreen(state, side) {
  const s = state.sides[side].screens;
  return s.reflect > 0 || s.lightScreen > 0;
}

export function useMove(dex, state, side, moveId) {
  DEX = dex;
  const user = activeOf(state, side);
  const foeSide = other(side);
  const foe = activeOf(state, foeSide);
  const m = dex.moves[moveId];
  const log = [];
  if (!m || !isAlive(user)) return log;

  const v = user.volatiles;
  v.flinch = 0;

  // sleep / freeze
  if (user.status === 'slp') {
    if (user.statusTurns === undefined) user.statusTurns = 2;
    user.statusTurns--;
    if (user.statusTurns <= 0) {
      user.status = null;
      log.push(`${user.name} 醒了`);
    } else {
      log.push(`${user.name} 正在睡觉`);
      return log;
    }
  }
  if (user.status === 'frz') {
    log.push(`${user.name} 被冰冻`);
    return log;
  }

  const type = effectiveMoveType(dex, user, m);
  const isStatus = m.category === 'Status';

  // protect
  if (v.protect) v.protect = 0;
  if (!isStatus && foe.volatiles.protect) {
    log.push(`${foe.name} 保护了自己`);
    return log;
  }

  // choice lock
  if (['choiceband', 'choicespecs', 'choicescarf'].includes(user.item)) user._choiceLock = moveId;

  log.push(`${user.name} 使用 ${moveZH(m)}`);

  // ---- self / ally target effects ----
  if (m.boosts && (m.target === 'self' || m.target === 'allySide' || m.target === 'allyTeam')) {
    applyBoosts(user, m.boosts, log, user.name);
  }
  if (m.heal) {
    healMon(user, Math.floor(user.maxHp * (m.heal[0] / m.heal[1])));
    log.push(`${user.name} 回复了体力`);
  }
  if (RECOVER.has(moveId)) {
    const amount = Math.floor(user.maxHp / 2);
    if (moveId === 'synthesis' || moveId === 'moonlight' || moveId === 'morningsun') {
      healMon(user, Math.floor(user.maxHp * (state.field.weather === 'sun' ? 2 / 3 : state.field.weather && state.field.weather !== 'sun' ? 1 / 4 : 1 / 2)));
    } else healMon(user, amount);
    log.push(`${user.name} 回复了体力`);
    return log;
  }
  if (m.weather) {
    state.field.weather = m.weather;
    state.field.weatherTurns = 5;
    log.push(`天气变成 ${WEATHER_ZH[m.weather] || m.weather}`);
  }
  if (m.terrain) {
    state.field.terrain = m.terrain;
    state.field.terrainTurns = 5;
  }
  if (m.sideCondition) {
    const sc = m.sideCondition;
    const my = state.sides[side];
    if (SCREEN[sc]) {
      my.screens[SCREEN[sc]] = 5;
      if (sc === 'auroraveil') { my.screens.reflect = 5; my.screens.lightScreen = 5; }
      log.push(`${user.name} 布置了防护墙`);
    } else if (HAZARD[sc]) {
      const oppSide = other(side);
      if (sc === 'spikes') state.sides[oppSide].hazards.spikes = Math.min(3, state.sides[oppSide].hazards.spikes + 1);
      else if (sc === 'toxicspikes') state.sides[oppSide].hazards.toxicspikes = Math.min(2, state.sides[oppSide].hazards.toxicspikes + 1);
      else state.sides[oppSide].hazards[sc] = 1;
      log.push(`${user.name} 布置了场地障碍`);
    }
    return log;
  }
  if (m.status && m.target === 'self') {
    user.status = m.status;
  }

  // ---- protect / substitute ----
  if (moveId === 'protect' || moveId === 'detect' || moveId === 'kingsshield' || moveId === 'spikyshield' || moveId === 'banefulbunker' || moveId === 'silktrap' || moveId === 'obstruct') {
    v.protect = 1;
    if (moveId === 'kingsshield') applyBoosts(user, { def: 2 }, log, user.name);
    log.push(`${user.name} 保护了自己`);
    return log;
  }
  if (moveId === 'substitute') {
    const cost = Math.floor(user.maxHp / 4);
    if (user.hp > cost) {
      damageMon(user, cost);
      v.substitute = Math.floor(user.maxHp / 4);
      log.push(`${user.name} 制造了替身`);
    }
    return log;
  }

  // ---- damaging ----
  if (!isStatus && m.basePower) {
    // accuracy handled by caller (deterministic hit)
    const fx = FIXED[moveId];
    if (fx) {
      let dmg = 0;
      if (fx === 'level') dmg = user.level;
      else if (fx === 'half') dmg = Math.floor(foe.hp / 2);
      else if (fx === 'endeavor') dmg = Math.max(0, foe.hp - user.hp);
      else if (fx === 'self') dmg = user.hp;
      else dmg = fx;
      dealToFoe(state, side, foe, dmg, log, m);
      return log;
    }
    if (OHKO.has(moveId)) {
      if (foe.level <= user.level) {
        dealToFoe(state, side, foe, foe.hp, log, m);
      } else log.push('但是没有命中');
      return log;
    }

    const hits = m.multihit && Array.isArray(m.multihit) ? 3 : 1;
    let total = 0;
    const d = calcDamage(dex, state, side, moveId);
    if (d.immune) {
      log.push(`对 ${foe.name} 无效`);
      return log;
    }
    for (let i = 0; i < hits; i++) {
      total += Math.floor((d.min + d.max) / 2);
    }
    dealToFoe(state, side, foe, total, log, m);

    // drain / recoil
    if (m.drain) {
      const heal = Math.floor(total * m.drain[0] / m.drain[1]);
      healMon(user, heal);
      log.push(`${user.name} 吸取了体力`);
    }
    if (m.recoil) {
      const rec = Math.floor(total * m.recoil[0] / m.recoil[1]);
      damageMon(user, rec);
      log.push(`${user.name} 受到反作用力伤害`);
    }
    if (user.item === 'lifeorb') {
      damageMon(user, Math.floor(user.maxHp / 10));
    }
    if (user.item === 'shellbell') healMon(user, Math.floor(total / 8));

    // secondary effects
    if (m.secondary) {
      const sec = m.secondary;
      if (sec.status) maybeStatus(foe, sec.status, log);
      if (sec.boosts) {
        const target = sec.self ? user : foe;
        applyBoosts(target, sec.boosts, log, target.name);
      }
      if (sec.volatileStatus === 'flinch') foe.volatiles.flinch = 1;
    }
    if (m.boosts && !(m.target === 'self')) {
      applyBoosts(foe, m.boosts, log, foe.name);
    }
    // self-boosting attacks (e.g. closecombat drops)
    if (m.self && m.self.boosts) applyBoosts(user, m.self.boosts, log, user.name);
  } else if (!isStatus && !m.basePower) {
    // status-ish moves targeting the foe
  }

  // ---- status moves ----
  if (isStatus) {
    if (m.status) {
      if (maybeStatus(foe, m.status, log)) log.push(`${foe.name} 陷入了${STATUS_ZH[m.status] || m.status}状态`);
    }
    if (m.boosts && m.target !== 'self') applyBoosts(foe, m.boosts, log, foe.name);
    if (m.volatileStatus) {
      const vs = m.volatileStatus;
      if (vs === 'confusion') foe.volatiles.confusion = 2;
      else if (vs === 'leechseed') foe.volatiles.leechseed = 1;
      else if (vs === 'taunt') foe.volatiles.taunt = 3;
      else if (vs === 'encore') foe.volatiles.encore = { move: foe.moves[0], turns: 3 };
      else if (vs === 'disable') foe.volatiles.disable = { move: foe.moves[0], turns: 3 };
      else if (vs === 'yawn') foe.volatiles.yawn = 2;
      else if (vs === 'substitute') { /* handled above */ }
      else foe.volatiles[vs] = 1;
      log.push(`${foe.name} 受到了 ${vs} 效果`);
    }
    if (moveId === 'healbell' || moveId === 'aromatherapy') {
      state[side].forEach((x) => { if (x.status && x.status !== 'slp') x.status = null; });
    }
    if (moveId === 'rest') {
      user.status = 'slp';
      user.statusTurns = 2;
      user.hp = user.maxHp;
      log.push(`${user.name} 睡着了，但回复了全部体力`);
    }
    if (moveId === 'defog') {
      state.sides[other(side)].hazards = { stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0 };
      state.sides[other(side)].screens = { reflect: 0, lightScreen: 0 };
      log.push('清除了场上的障碍');
    }
    if (moveId === 'rapidspin') {
      state.sides[side].hazards = { stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0 };
      applyBoosts(user, { spe: 1 }, log, user.name);
    }
    if (moveId === 'trickroom') {
      state.field.trickRoom = state.field.trickRoom ? 0 : 5;
    }
  }

  // ---- switch-out moves ----
  if (SELF_SWITCH.has(moveId)) {
    user._needSwitch = true;
  }
  if (FORCE_SWITCH.has(moveId)) {
    foe._forceSwitch = true;
  }
  return log;
}

function applyBoosts(mon, boosts, log, name) {
  if (!mon || !boosts) return;
  let lowered = false;
  for (const [k, v] of Object.entries(boosts)) {
    if (mon.boosts[k] === undefined) continue;
    const before = mon.boosts[k];
    mon.boosts[k] = Math.max(-6, Math.min(6, before + v));
    if (mon.boosts[k] !== before) {
      log.push(`${name} 的${{ atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度', acc: '命中', eva: '闪避' }[k]}${v > 0 ? '提升' : '下降'}`);
      if (mon.boosts[k] < before) lowered = true;
    }
  }
  // 白色香草：能力被下降时自动清除所有下降，并消耗道具
  if (lowered && mon.item === 'whiteherb') {
    let cleaned = false;
    for (const k of Object.keys(mon.boosts)) {
      if (mon.boosts[k] < 0) { mon.boosts[k] = 0; cleaned = true; }
    }
    if (cleaned) {
      mon.baselineBoosts = Object.assign({}, mon.boosts);
      mon.item = null;
      log.push(`${name} 的白色香草清除了能力下降`);
    }
  }
}

function maybeStatus(mon, status, log) {
  if (mon.status) return false;
  if (status === 'brn' && mon.types.includes('Fire')) return false;
  if (status === 'frz' && mon.types.includes('Ice')) return false;
  if (status === 'psn' && (mon.types.includes('Poison') || mon.types.includes('Steel'))) return false;
  if (status === 'tox' && mon.types.includes('Steel')) return false;
  if ((status === 'par') && mon.types.includes('Electric')) return false;
  mon.status = status;
  mon.statusTurns = status === 'slp' ? 2 : 0;
  return true;
}

function dealToFoe(state, side, foe, amount, log, move) {
  // substitute absorbs
  if (foe.volatiles && foe.volatiles.substitute > 0) {
    const absorbed = Math.min(foe.volatiles.substitute, amount);
    foe.volatiles.substitute -= absorbed;
    if (foe.volatiles.substitute <= 0) {
      foe.volatiles.substitute = 0;
      log.push('替身被打消');
    }
    return;
  }
  damageMon(foe, amount);
  if (foe.hp <= 0) log.push(`${foe.name} 倒下了`);
}

// ---------------------------------------------------------------- switching / faints

// A real switch: the bench mon replaces the current active and joins the field.
// The mon that leaves the field goes back to the bench.
export function doSwitch(dex, state, side, index) {
  const log = [];
  const prev = state.active[side];
  const withBench = state.bench[side] === index;
  const old = state[side][prev];
  if (!state.onField[side].includes(index)) state.onField[side].push(index);
  if (withBench) {
    state.bench[side] = prev;
    // 和后台那只交换（消耗一回合）才会清掉能力变化；场上 3 只之间轮转不清
    if (old) {
      const had = Object.values(old.boosts || {}).some((v) => v !== 0);
      if (had) log.push(`${old.name} 的能力变化消失了`);
      old.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
      old.volatiles = {};
    }
  }
  state.active[side] = index;
  log.push(...switchIn(dex, state, side, index));
  return log;
}

// Export kept for backwards compatibility with earlier callers.
export const performSwitch = doSwitch;

// Make sure the active slot points at something alive on the field.
export function ensureActive(state, side) {
  const cur = state[side][state.active[side]];
  if (isAlive(cur)) return;
  const field = state.onField[side].filter((i) => isAlive(state[side][i]));
  if (field.length) {
    state.active[side] = field[0];
    return;
  }
  const b = state.bench[side];
  if (b !== undefined && b >= 0 && isAlive(state[side][b])) {
    state.onField[side].push(b);
    state.bench[side] = -1;
    state.active[side] = b;
  }
}

export const autoSwitch = (dex, state, side) => ensureActive(state, side);

// ---------------------------------------------------------------- end of turn

export function endTurn(dex, state) {
  const log = [];
  for (const side of ['mine', 'theirs']) {
    const mon = activeOf(state, side);
    if (!mon || !isAlive(mon)) continue;
    // leftovers / black sludge
    if (mon.item === 'leftovers') healMon(mon, Math.floor(mon.maxHp / 16));
    if (mon.item === 'blacksludge') {
      if (mon.types.includes('Poison')) healMon(mon, Math.floor(mon.maxHp / 16));
      else damageMon(mon, Math.floor(mon.maxHp / 8));
    }
    if (mon.item === 'stickybarb' || mon.item === 'flameorb') { /* no-op for now */ }
    // status damage
    if (mon.status === 'brn') damageMon(mon, Math.floor(mon.maxHp / 8)); // Gen 5 burn
    if (mon.status === 'psn') damageMon(mon, Math.floor(mon.maxHp / 8));
    if (mon.status === 'tox') damageMon(mon, Math.floor(mon.maxHp * Math.min(15, mon._toxCounter || 1) / 16)), mon._toxCounter = Math.min(15, (mon._toxCounter || 1) + 1);
    // leech seed
    if (mon.volatiles.leechseed) {
      const amount = Math.floor(mon.maxHp / 8);
      damageMon(mon, amount);
      const foe = activeOf(state, other(side));
      if (foe && isAlive(foe)) healMon(foe, amount);
    }
  }
  // weather residual
  const w = state.field.weather;
  if (w === 'sand' || w === 'snow') {
    for (const side of ['mine', 'theirs']) {
      const mon = activeOf(state, side);
      if (!mon || !isAlive(mon)) continue;
      if (w === 'sand' && !mon.types.some((t) => ['Rock', 'Steel', 'Ground'].includes(t))) {
        damageMon(mon, Math.floor(mon.maxHp / 16));
      }
      if (w === 'snow' && !mon.types.includes('Ice')) {
        damageMon(mon, Math.floor(mon.maxHp / 16));
      }
    }
  }
  // timers
  for (const side of ['mine', 'theirs']) {
    const s = state.sides[side].screens;
    for (const k of Object.keys(s)) if (s[k] > 0) s[k]--;
  }
  if (state.field.weatherTurns > 0) {
    state.field.weatherTurns--;
    if (state.field.weatherTurns === 0) state.field.weather = null;
  }
  if (state.field.terrainTurns > 0) {
    state.field.terrainTurns--;
    if (state.field.terrainTurns === 0) state.field.terrain = null;
  }
  for (const side of ['mine', 'theirs']) {
    const mon = activeOf(state, side);
    if (!mon) continue;
    if (mon.volatiles.taunt > 0) mon.volatiles.taunt--;
    if (mon.volatiles.encore) { mon.volatiles.encore.turns--; if (mon.volatiles.encore.turns <= 0) delete mon.volatiles.encore; }
  }
  state.field.turn++;
  return log;
}

// ---------------------------------------------------------------- full turn

export function resolveTurn(dex, state, myAction, oppAction) {
  DEX = dex;
  const s = clone(state);
  const log = [];
  const acts = [
    { side: 'mine', a: myAction },
    { side: 'theirs', a: oppAction },
  ];

  // 1) a real switch (bench -> field) resolves before any attack
  for (const x of acts) {
    if (x.a && x.a.type === 'switch') {
      const idx = x.a.mon !== undefined ? x.a.mon : x.a.index;
      log.push(...doSwitch(dex, s, x.side, idx));
    }
  }
  ensureActive(s, 'mine');
  ensureActive(s, 'theirs');

  // 2) rotation: the mon that attacks this turn is the mon standing on the field
  for (const x of acts) {
    if (x.a && x.a.type === 'move' && x.a.mon !== undefined && s.onField[x.side].includes(x.a.mon)) {
      s.active[x.side] = x.a.mon;
    }
  }

  // 3) order by priority, then speed
  const movers = acts.filter((x) => x.a && x.a.type === 'move');
  const withSpeed = movers.map((x) => {
    const mon = s[x.side][s.active[x.side]];
    const mv = dex.moves[x.a.moveId];
    return {
      ...x,
      priority: mv ? mv.priority || 0 : 0,
      speed: mon ? speedOf(s, x.side, mon) : 0,
    };
  });
  withSpeed.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const speedDiff = b.speed - a.speed;
    if (speedDiff !== 0) return speedDiff;
    return a.side === 'mine' ? -1 : 1; // deterministic tie-break
  });

  for (const mv of withSpeed) {
    if (isOver(s)) break;
    const mon = s[mv.side][s.active[mv.side]];
    if (!mon || !isAlive(mon) || !canAct(mon)) continue;
    const foe = s[other(mv.side)][s.active[other(mv.side)]];
    if (!foe || !isAlive(foe)) continue;
    log.push(...useMove(dex, s, mv.side, mv.a.moveId));
    if (!isAlive(s[mv.side][s.active[mv.side]]) || !isAlive(s[other(mv.side)][s.active[other(mv.side)]])) {
      break; // a faint ends the exchange
    }
  }

  // 4) forced / self switch moves
  for (const side of ['mine', 'theirs']) {
    const mon = s[side][s.active[side]];
    if (mon && mon._needSwitch) {
      mon._needSwitch = false;
      const idx = s.onField[side].find((i) => i !== s.active[side] && isAlive(s[side][i]));
      if (idx !== undefined) doSwitch(dex, s, side, idx);
    }
  }

  // 5) the bench fills any empty field slot, then residuals tick
  for (const side of ['mine', 'theirs']) {
    promoteBench(s, side);
    ensureActive(s, side);
  }

  log.push(...endTurn(dex, s));
  for (const side of ['mine', 'theirs']) {
    promoteBench(s, side);
    ensureActive(s, side);
  }
  if (isOver(s)) log.push(aliveCount(s.mine) === 0 ? '你输了' : '你赢了');
  s.log = (state.log || []).concat(log);
  return { state: s, log };
}
