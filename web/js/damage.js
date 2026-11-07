// Damage calculation, Gen 9 formula.
// All multiplicative modifiers are pre-computed by the battle layer and passed in `mods`,
// so this function stays pure and cheap (called thousands of times during search).

export function damageRange(o) {
  const {
    level = 50,
    power = 0,
    atkStat,
    defStat,
    moveType,
    moveCategory = 'Physical',
    defTypes = [],
    attackerTypes = [],
    chart,
    mods = {},
  } = o;

  if (!power || power <= 0) return { min: 0, max: 0, base: 0 };

  const atk = Math.max(1, atkStat);
  const def = Math.max(1, defStat);

  let base = Math.floor((Math.floor((2 * level) / 5 + 2) * power * atk) / def / 50) + 2;

  // type effectiveness
  // 属性相克：chart[攻击属性][防御属性] = 2 / 0.5 / 0，缺省为 1（一倍）
  let type = 1;
  const row = chart && chart[moveType];
  for (const d of defTypes) {
    const v = row && Object.prototype.hasOwnProperty.call(row, d) ? row[d] : 1;
    type *= v;
  }
  if (type === 0) return { min: 0, max: 0, base, typeMul: 0 };

  // STAB
  let stab = attackerTypes.includes(moveType) ? 1.5 : 1;
  if (mods.adaptability && stab > 1) stab = 2;

  const weather = mods.weatherMul || 1;
  // Gen 5 critical hits deal 2x damage (Gen 6+ uses 1.5x).
  const crit = mods.crit ? (mods.critMul || 2) : 1;
  const burn = mods.burned && moveCategory === 'Physical' ? 0.5 : 1;
  const screen = mods.screen ? (mods.screenMul || 0.5) : 1;
  const other = mods.otherMul || 1;
  const spread = mods.spread ? 0.75 : 1;

  const core = stab * type * weather * crit * burn * screen * spread * other;

  const max = Math.floor(Math.floor(base * core) * 1.0);
  const min = Math.floor(Math.floor(base * core) * 0.85);
  return { min, max, base, typeMul: type, stabMul: stab, core };
}

// Convenience: percent of a max HP value.
export function pct(dmg, maxHp) {
  return maxHp > 0 ? dmg / maxHp : 0;
}

// Roll quality: 1 = guaranteed KO, 0.5 = roll, 0 = no KO
export function koChance(min, max, hp) {
  if (max < hp) return 0;
  if (min >= hp) return 1;
  const span = max - min;
  if (span <= 1) return 0.5;
  return Math.min(1, Math.max(0, (max - hp + 1) / (span + 1)));
}
