// Decision engine for the rotation format: rank every (mon, move) action by an
// estimated win chance, then let the UI explain why.
import { activeOf, other, isOver, calcDamage, typeEffect } from './battle.js';
import { resolveTurn, legalActions } from './turn.js';
import { isAlive, speedOf, aliveCount } from './mon.js';
import { koChance } from '../damage.js';

// 第五世代暴击率：普通招式 1/16，高暴击招式 1/8，超幸运再翻倍
const CRIT_BASE = 1 / 16;

// 本局池子：speciesId -> 固定配招。随机对战的招式是固定的，知道池子就不用瞎猜。
let POOL_MOVES = null;
export function setPoolMoves(map) { POOL_MOVES = map && Object.keys(map).length ? map : null; }
export function poolMoveList(speciesId) {
  return POOL_MOVES && POOL_MOVES[speciesId] ? POOL_MOVES[speciesId] : null;
}


// Win probability estimate from the current position (0 = lost, 1 = won).
export function evaluate(state) {
  const n = state.mine.length || 1;
  const myAlive = aliveCount(state.mine);
  const opAlive = aliveCount(state.theirs);
  if (myAlive === 0) return 0;
  if (opAlive === 0) return 1;
  let myHp = 0, oppHp = 0;
  for (const m of state.mine) myHp += isAlive(m) ? m.hp / m.maxHp : 0;
  for (const m of state.theirs) oppHp += isAlive(m) ? m.hp / m.maxHp : 0;
  myHp /= n; oppHp /= n;
  const x = 3.0 * (myHp - oppHp) + 3.0 * (myAlive / n - opAlive / n);
  return 0.5 + 0.5 * Math.tanh(x);
}

// calcDamage always reads the active slot, so point it at a specific mon.
function dmgFor(dex, state, side, monIdx, moveId) {
  const prev = state.active[side];
  state.active[side] = monIdx;
  let d;
  try {
    d = calcDamage(dex, state, side, moveId);
  } finally {
    state.active[side] = prev;
  }
  return d;
}

function accuracyOf(dex, moveId) {
  const m = dex.moves[moveId];
  if (!m) return 1;
  if (m.accuracy === true || m.accuracy === undefined || m.accuracy === null) return 1;
  const a = Number(m.accuracy);
  if (!isFinite(a) || a <= 0) return 1;
  return a / 100;
}

// Best damaging move a mon could plausibly run, judged against `foeTypes`.
// Used to model moves the opponent has not revealed yet.
export function priorBestMove(dex, species, foeTypes) {
  const sp = dex.species[species];
  if (!sp) return null;
  const learn = dex.learnsets[species] || [];
  let best = null, bestScore = -1;
  for (const id of learn) {
    const m = dex.moves[id];
    if (!m || !m.basePower || m.basePower < 40) continue;
    if (m.category === 'Status') continue;
    const stab = sp.types.includes(m.type) ? 1.5 : 1;
    const eff = typeEffect(dex, m.type, foeTypes || []);
    const acc = accuracyOf(dex, id);
    const score = m.basePower * stab * eff * acc;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

// Every action the opponent might take next turn.
export function oppActions(dex, state) {
  const acts = [];
  const myTypes = (activeOf(state, 'mine') || { types: [] }).types;
  for (const idx of state.onField.theirs || []) {
    const mon = state.theirs[idx];
    if (!isAlive(mon)) continue;
    const pool = poolMoveList(mon.speciesId);
    if (pool && pool.length) {
      // 池子里的配招是固定的，直接全列出来
      for (const id of pool) if (dex.moves[id]) acts.push({ type: 'move', mon: idx, moveId: id, fromPool: true });
      continue;
    }
    const known = (mon.moves || []).filter(Boolean);
    for (const id of known) acts.push({ type: 'move', mon: idx, moveId: id });
    if (known.length < 4) {
      const id = priorBestMove(dex, mon.speciesId, myTypes);
      if (id && !known.includes(id)) acts.push({ type: 'move', mon: idx, moveId: id, synthetic: true });
    }
  }
  const b = state.bench.theirs;
  if (b !== undefined && b >= 0 && isAlive(state.theirs[b])) {
    acts.push({ type: 'switch', mon: b, index: b });
  }
  return acts;
}

function critChanceOf(dex, moveId, mon) {
  const m = dex.moves[moveId];
  let c = m && m.critRatio && m.critRatio > 1 ? 1 / 8 : CRIT_BASE;
  if (mon && mon.ability === 'superluck') c *= 2;
  return Math.min(1, c);
}

// 把"可能打不中"和"可能暴击"算进去的击杀概率
export function koProbability(min, max, hp, acc, critC) {
  const critDmg = Math.max(min, max) * 2; // 第五世代暴击翻倍
  const pRoll = koChance(min, max, hp);
  const pCrit = critDmg >= hp ? 1 : 0;
  return Math.max(0, Math.min(1, acc * ((1 - critC) * pRoll + critC * pCrit)));
}


function greedyAction(dex, state, side) {
  const all = legalActions(state, side);
  const moves = all.filter((a) => a.type === 'move');
  const foe = activeOf(state, other(side));
  if (!moves.length || !foe) return all[0];
  let best = moves[0], bestVal = -Infinity;
  for (const a of moves) {
    const d = dmgFor(dex, state, side, a.mon, a.moveId);
    if (d.immune) continue;
    const avg = Math.min(foe.hp, ((d.min + d.max) / 2) * accuracyOf(dex, a.moveId));
    const val = avg + (avg >= foe.hp ? 60 : 0);
    if (val > bestVal) { bestVal = val; best = a; }
  }
  return best;
}

// Play a couple of turns with greedy policies from both sides, then evaluate.
export function rollout(dex, state, turns = 2) {
  let s = state;
  for (let i = 0; i < turns; i++) {
    if (isOver(s)) break;
    const my = greedyAction(dex, s, 'mine');
    const op = greedyAction(dex, s, 'theirs');
    if (!my || !op) break;
    s = resolveTurn(dex, s, my, op).state;
  }
  return evaluate(s);
}

export function rankActions(dex, state, opts = {}) {
  const myActs = legalActions(state, 'mine');
  const opps = oppActions(dex, state);
  if (!myActs.length) return [];
  const base = evaluate(state);

  // 如果这一回合我什么都没打中，局面大概值多少：每个对手动作只算一次
  const missVals = opps.map((o) => {
    if (o.type !== 'move') return base;
    try {
      return evaluate(resolveTurn(dex, state, { type: 'skip' }, o).state);
    } catch (e) {
      return base;
    }
  });

  const first = [];

  // Pass 1: cheap evaluation against every opponent action.
  for (const a of myActs) {
    const acc = a.type === 'move' ? accuracyOf(dex, a.moveId) : 1;
    let worst = 1, sum = 0, n = 0, sample = null;
    for (let j = 0; j < opps.length; j++) {
      const o = opps[j];
      const r = resolveTurn(dex, state, a, o);
      let v = evaluate(r.state);
      // 命中率折算：打不中就退回"这回合白打"的局面
      if (acc < 0.999) v = acc * v + (1 - acc) * missVals[j];
      worst = Math.min(worst, v); sum += v; n++;
      if (!sample) sample = r;
    }
    first.push({ action: a, worst, avg: n ? sum / n : 0.5, sample, acc });
  }
  first.sort((x, y) => (0.65 * y.worst + 0.35 * y.avg) - (0.65 * x.worst + 0.35 * x.avg));

  // Pass 2: spend the rollout budget on the most promising few.
  const topN = opts.topN || 5;
  const out = first.map((r, i) => {
    let score = 0.65 * r.worst + 0.35 * r.avg;
    let look = 0;
    if (i < topN && r.sample) {
      look = rollout(dex, r.sample.state, 1);
      score = 0.72 * score + 0.28 * look;
    }
    return { ...r, score, look };
  });
  out.sort((x, y) => y.score - x.score);
  return out;
}

// Damage from one of my field mons into one specific enemy field mon.
function dmgAgainst(dex, state, monIdx, moveId, foeIdx) {
  const prevT = state.active.theirs;
  state.active.theirs = foeIdx;
  try {
    return dmgFor(dex, state, 'mine', monIdx, moveId);
  } finally {
    state.active.theirs = prevT;
  }
}

// Per-target damage breakdown for the chosen action (used by the UI cards).
export function damagesAgainst(dex, state, action) {
  if (!action || action.type !== 'move') return [];
  const out = [];
  for (const idx of state.onField.theirs) {
    const foe = state.theirs[idx];
    if (!isAlive(foe)) continue;
    const d = dmgAgainst(dex, state, action.mon, action.moveId, idx);
    if (!d) continue;
    const acc = accuracyOf(dex, action.moveId);
    const cC = critChanceOf(dex, action.moveId, state.mine[action.mon]);
    out.push({
      idx,
      foe,
      min: d.min,
      max: d.max,
      immune: !!d.immune,
      pctMin: Math.min(100, Math.round((d.min / foe.maxHp) * 100)),
      pctMax: Math.min(100, Math.round((d.max / foe.maxHp) * 100)),
      ko: d.max >= foe.hp,
      koProb: d.immune ? 0 : koProbability(d.min, d.max, foe.hp, acc, cC),
      acc,
      eff: d.eff,
    });
  }
  out.sort((a, b) => b.pctMin - a.pctMin);
  return out;
}

// ------------------------------------------------------------------ explanation

// Human-readable details for one candidate action against one enemy mon.
export function explain(dex, state, action, foeIdx) {
  const foe = foeIdx !== undefined ? state.theirs[foeIdx] : activeOf(state, other('mine'));
  const mon = state.mine[action.mon !== undefined ? action.mon : state.active.mine];
  if (!mon || !foe) return null;
  if (action.type === 'switch') {
    const b = state.mine[action.mon];
    return { kind: 'switch', mon: b, text: `换上 ${b.name}` };
  }
  const d = dmgAgainst(dex, state, action.mon, action.moveId, foeIdx !== undefined ? foeIdx : state.active.theirs);
  const m = dex.moves[action.moveId];
  const pctMin = Math.min(100, Math.round((d.min / foe.maxHp) * 100));
  const pctMax = Math.min(100, Math.round((d.max / foe.maxHp) * 100));
  const acc = accuracyOf(dex, action.moveId);
  const ko = d.max >= foe.hp;
  const cC = critChanceOf(dex, action.moveId, mon);
  return {
    kind: 'move',
    mon,
    foe,
    move: m,
    min: d.min,
    max: d.max,
    eff: d.eff,
    pctMin,
    pctMax,
    acc,
    ko,
    koProb: d.immune ? 0 : koProbability(d.min, d.max, foe.hp, acc, cC),
    immune: !!d.immune,
    faster: speedOf(state, 'mine', mon) >= speedOf(state, 'theirs', foe),
  };
}

