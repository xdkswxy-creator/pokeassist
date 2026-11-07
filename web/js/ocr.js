// 截图识别：把 OCR 出来的文字行，拼成"精灵 + 招式 + 道具 + 特性"
// 只做匹配和分组，不做什么花哨的东西。

const CJK = /[\u3400-\u9fff]/;

function norm(s) {
  return String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[|｜·•・:：;；,，.。/\\()（）\[\]【】<>《》"'`~!@#$%^&*+=？?！!_\-—–]/g, '')
    .replace(/^[♀♂]+/, '')
    .trim();
}

function dist(a, b, cutoff = 3) {
  // 莱文斯坦距离，超过 cutoff 就提前返回
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > cutoff) return cutoff + 1;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > cutoff) return cutoff + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

function buildDict(dex) {
  const d = { species: [], moves: [], items: [], abilities: [] };
  const add = (kind, id, name) => {
    const zh = name && norm(name);
    if (!zh) return;
    if (zh.length < 2) return;
    d[kind].push({ id, zh });
  };
  for (const [id, sp] of Object.entries(dex.species || {})) {
    add('species', id, dex.zh?.species?.[id] || sp.name);
  }
  for (const [id, mv] of Object.entries(dex.moves || {})) {
    add('moves', id, dex.zh?.moves?.[id] || mv.name);
  }
  for (const [id, it] of Object.entries(dex.items || {})) {
    add('items', id, dex.zh?.items?.[id] || it.name);
  }
  for (const [id, ab] of Object.entries(dex.abilities || {})) {
    add('abilities', id, dex.zh?.abilities?.[id] || ab.name);
  }
  return d;
}

let DICT = null;
export function ensureDict(dex) {
  if (!DICT) DICT = buildDict(dex);
  return DICT;
}

// 在一类字典里找最像的；返回 {id, zh, score}
function bestIn(list, raw) {
  const t = norm(raw);
  if (!t || t.length < 2) return null;
  let best = null;
  for (const it of list) {
    let score = 0;
    if (t === it.zh) score = 100;
    // 语言包会在名字后追加属性词："太古盔甲岩水" 也要能认成 太古盔甲
    else if (t.startsWith(it.zh) && it.zh.length >= 2 && t.length > it.zh.length) score = 96 - (t.length - it.zh.length);
    else if (t.length >= 2 && t.includes(it.zh)) score = 80 - (t.length - it.zh.length);
    else if (it.zh.length >= 2 && it.zh.includes(t) && t.length >= 2) score = 70 - (it.zh.length - t.length);
    else {
      const d = dist(t, it.zh, 2);
      if (d <= 1) score = 60;
      else if (d === 2 && it.zh.length >= 4) score = 40;
    }
    if (score > 0 && (!best || score > best.score)) best = { id: it.id, zh: it.zh, score };
  }
  return best;
}

// 去掉"火/水/恶"这种属性前缀后匹配得更好
function bestAny(raw) {
  let r = bestIn(DICT.moves, raw);
  let kind = 'moves';
  const it = bestIn(DICT.items, raw);
  const ab = bestIn(DICT.abilities, raw);
  if (it && (!r || it.score > r.score)) { r = it; kind = 'items'; }
  if (ab && (!r || ab.score > r.score)) { r = ab; kind = 'abilities'; }
  return r ? { ...r, kind } : null;
}

const LV_RE = /(Lv\.?\s*\d{1,3}|等级\s*\d{1,3})/i;
// 语言包会把属性也当文字，单独一行的属性词直接忽略
// 界面按钮/固定文字，认出来也别当招式
const UI_WORDS = ['准备完成', '开始对战', '战斗', '宝可梦', '资料', '投降', '恭喜', '回合', '秒'];
function isUiNoise(t) {
  const n = norm(t);
  if (!n) return true;
  if (n.length < 2) return true;
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(n)) return true;  // 纯数字/标点（Lv. 75 之类）
  return UI_WORDS.some((w) => n.indexOf(w) >= 0);
}

const TYPE_WORDS = new Set(['一般', '火', '水', '电', '草', '冰', '格斗', '毒', '地面', '飞行',
  '超能', '虫', '岩石', '幽灵', '龙', '恶', '钢', '妖精']);

export function parseCards(dex, lines) {
  ensureDict(dex);
  const rows = (lines || [])
    .map(l => ({ ...l, t: String(l.text || '') }))
    .filter(l => norm(l.t).length >= 2)
    .filter(l => !TYPE_WORDS.has(norm(l.t)) && !isUiNoise(l.t));

  // 1) 找卡头（带 Lv.75 的行）
  const heads = [];
  for (const l of rows) {
    if (LV_RE.test(l.t) || /Lv/i.test(l.t)) {
      const noLv = l.t.replace(LV_RE, '').replace(/Lv\.?\s*\d*/i, '');
      const seg = noLv.split(/[|｜]/).filter(Boolean);
      const tail = seg.length ? seg[seg.length - 1] : noLv;
      const cand = bestIn(DICT.species, tail) || bestIn(DICT.species, noLv) || bestIn(DICT.species, l.t);
      heads.push({
        raw: l.t,
        species: cand ? cand.zh : norm(tail).slice(-5),
        speciesId: cand ? cand.id : null,
        score: cand ? cand.score : 0,
        x: l.x, y: l.y, w: l.w, h: l.h,
        lines: [],
      });
    }
  }
  if (!heads.length) return [];

  // 2) 按 x 分列，每列里按 y 排序
  const cols = [];
  for (const h of heads.slice().sort((a, b) => a.x - b.x)) {
    let col = cols.find(c => Math.abs(c.x - h.x) < Math.max(60, h.w * 0.8));
    if (!col) { col = { x: h.x, heads: [] }; cols.push(col); }
    col.heads.push(h);
  }

  // 3) 非卡头行：找同一列、最近的卡头
  const usedHeads = heads.slice();
  for (const l of rows) {
    if (heads.includes(l.__head || null)) continue;
    if (heads.some(h => h.raw === l.t)) continue;
    let best = null;
    for (const h of usedHeads) {
      const dx = Math.abs(h.x - l.x);
      const dy = l.y - h.y;
      if (dy < -8) continue;                 // 在卡头上面的不算
      if (dx > 260) continue;                // 太远
      const cost = dx * 1.0 + Math.abs(dy) * 0.25;
      if (!best || cost < best.cost) best = { h, cost };
    }
    if (best) best.h.lines.push(l);
  }

  // 4) 每张卡：先认道具/特性，剩下的当招式
  for (const h of heads) {
    const ls = h.lines.slice().sort((a, b) => a.y - b.y);
    const named = [];
    for (const l of ls) {
      const m = bestAny(l.t);
      if (m) named.push({ raw: l.t, ...m, y: l.y });
      else named.push({ raw: l.t, id: null, zh: null, kind: null, score: 0, y: l.y });
    }
    const item = named.find(n => n.kind === 'items' && n.score >= 60);
    const ability = named.find(n => n.kind === 'abilities' && n.score >= 60);
    const moves = named
      .filter(n => n !== item && n !== ability && n.kind === 'moves')
      .slice(0, 4);
    h.itemId = item ? item.id : null;
    h.itemZh = item ? item.zh : null;
    h.abilityId = ability ? ability.id : null;
    h.abilityZh = ability ? ability.zh : null;
    h.moves = moves.map(m => ({ id: m.id, zh: m.zh, raw: m.raw, score: m.score }));
    h.unknown = named.filter(n => !n.id).map(n => n.raw);
  }

  // 5) 按行排列（先上后下、先左后右）
  heads.sort((a, b) => (Math.abs(a.y - b.y) < 40 ? a.x - b.x : a.y - b.y));
  return heads;
}
