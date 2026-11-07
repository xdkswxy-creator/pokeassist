// Type effectiveness helpers.
// Showdown typechart format: chart[attackingType][defendingType] = 0 neutral / 1 weak / 2 resist / 3 immune

export function effectiveness(chart, atkType, defTypes) {
  let m = 1;
  const row = chart[atkType];
  for (const d of defTypes) {
    const v = row && Object.prototype.hasOwnProperty.call(row, d) ? row[d] : 1;
    m *= v;
  }
  return m;
}

// Human readable, e.g. "效果绝佳(×2)" / "效果不好(×0.5)" / "无效(×0)"
export function effectivenessLabel(m) {
  if (m === 0) return { text: '无效', cls: 'eff-0' };
  if (m >= 4) return { text: '效果绝佳 ×4', cls: 'eff-4' };
  if (m > 1) return { text: '效果绝佳 ×2', cls: 'eff-2' };
  if (m === 1) return { text: '一般', cls: 'eff-1' };
  return { text: '效果不好 ×0.5', cls: 'eff-half' };
}
