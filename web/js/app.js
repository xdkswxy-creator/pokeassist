// PokeMMO 随机对战助手 — UI 主逻辑（无框架、无打包）
import { loadDexBrowser, speciesName, moveName, abilityName, itemName } from './dex.js';
import { createMon, speedOf, isAlive, aliveCount } from './engine/mon.js';
import { newState, promoteBench } from './engine/battle.js';
import { rankActions, damagesAgainst, evaluate, oppActions, setPoolMoves } from './engine/search.js';
import { resolveTurn, setDex, ensureActive } from './engine/turn.js';
import { NATURE_ZH } from './natures.js';
import { parseCards } from './ocr.js';

// ------------------------------------------------------------------ constants

const TYPE_ZH = {
  Normal: '一般', Fire: '火', Water: '水', Electric: '电', Grass: '草', Ice: '冰',
  Fighting: '格斗', Poison: '毒', Ground: '地面', Flying: '飞行', Psychic: '超能',
  Bug: '虫', Rock: '岩石', Ghost: '幽灵', Dragon: '龙', Dark: '恶', Steel: '钢',
};
const TYPE_COLOR = {
  Normal: '#7d8177', Fire: '#e62829', Water: '#2980ef', Electric: '#d9a400',
  Grass: '#3fa129', Ice: '#31b6d6', Fighting: '#e07000', Poison: '#9141cb',
  Ground: '#915121', Flying: '#6fa8e0', Psychic: '#ef4179', Bug: '#91a119',
  Rock: '#a8a074', Ghost: '#704170', Dragon: '#5060e1', Dark: '#5a4a4b',
  Steel: '#5f9aae',
};
const STATUS_ZH = { brn: '灼伤', par: '麻痹', slp: '睡眠', psn: '中毒', tox: '剧毒', frz: '冰冻' };
const STAT_ZH = { atk: '攻', def: '防', spa: '特攻', spd: '特防', spe: '速', acc: '命中', eva: '闪避' };
const WEATHER_ZH = { rain: '下雨', sun: '晴天', sand: '沙暴', snow: '冰雹' };

const COMMON_ITEMS = [
  'leftovers', 'lifeorb', 'choiceband', 'choicespecs', 'choicescarf', 'focusash',
  'blacksludge', 'sitrusberry', 'lumberry', 'rockyhelmet', 'assaultvest', 'eviolite',
  'airballoon', 'expertbelt', 'toxicorb', 'flameorb', 'dampmulch', 'lightclay',
];
const COMMON_NATURES = ['adamant', 'jolly', 'modest', 'timid', 'naive', 'hasty', 'bold', 'impish',
  'careful', 'calm', 'relaxed', 'sassy', 'quiet', 'brave', 'hardy', 'naughty', 'lonely', 'mild', 'rash', 'gentle'];

const LS_KEY = 'pokeassist.v2';

// ------------------------------------------------------------------ helpers

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const normId = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function typeChip(t) {
  return `<span class="tc" style="background:${TYPE_COLOR[t] || '#555'}">${TYPE_ZH[t] || t}</span>`;
}
function typeChips(types) {
  return (types || []).map(typeChip).join(' ');
}
function hpColor(pct) {
  return pct > 50 ? '#3ddc84' : pct > 20 ? '#ffb020' : '#ff5c5c';
}
function monName(sideMon) {
  return sideMon ? sideMon.name : '?';
}

// ------------------------------------------------------------------ app state

const app = {
  dex: null,
  my: [null, null, null, null],
  opp: [null, null, null, null],
  battle: null,
  ranked: [],
  choice: null,
  oppAction: null,
  turnNo: 1,
  logs: [],
  history: [],
  tab: 'setup',
  lib: {},
  cloud: null,
  nameIndex: null,
};

function blankSet(speciesId) {
  return { speciesId, moves: [], item: null, ability: null, nature: 'hardy' };
}

// ------------------------------------------------------------------ persistence

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      my: app.my, opp: app.opp, battle: app.battle,
      turnNo: app.turnNo, logs: app.logs, tab: app.tab, guideOff: app.guideOff,
      records: app.records || [], ocrLast: app.ocrLast || null,
    }));
  } catch (e) { /* ignore quota errors */ }
  try { rememberTeam(); } catch (e) { /* ignore */ }
}

function restore() {
  let d;
  try { d = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { d = null; }
  if (!d) return;
  if (Array.isArray(d.my) && d.my.length === 4) app.my = d.my;
  if (Array.isArray(d.opp) && d.opp.length === 4) app.opp = d.opp;
  if (d.guideOff) app.guideOff = true;
  if (Array.isArray(d.records)) app.records = d.records;
  if (d.ocrLast) app.ocrLast = d.ocrLast;
  if (d.battle && d.battle.mine) {
    app.battle = d.battle;
    app.turnNo = d.turnNo || 1;
    app.logs = d.logs || [];
    app.tab = d.tab === 'setup' ? 'setup' : 'battle';
  }
  // 清理历史遗留的 _dex
  if (app.battle && app.battle._dex) delete app.battle._dex;
}

// ------------------------------------------------------------------ 数据池 / 精灵套库
// 每一把录入的精灵配招都会被记住；下次选到同一只自动填好。数据还会同步到服务端，
// 这样自己和朋友的所有设备共用同一份库。

const LIB_KEY = 'pokeassist.lib.v1';

function foldName(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_.'’·（）()：:，,、]/g, '');
}

function buildNameIndex() {
  if (app.nameIndex) return app.nameIndex;
  const mk = (obj, zhMap) => {
    const m = new Map();
    for (const [id, v] of Object.entries(obj || {})) {
      m.set(foldName(id), id);
      if (v && v.name) m.set(foldName(v.name), id);
      const zh = zhMap && zhMap[id];
      if (zh) m.set(foldName(zh), id);
    }
    return m;
  };
  const zh = app.dex.zh || {};
  app.nameIndex = {
    species: mk(app.dex.species, zh.species),
    moves: mk(app.dex.moves, zh.moves),
    items: mk(app.dex.items, zh.items),
    abilities: mk(app.dex.abilities, zh.abilities),
    natures: mk({ adamant: { name: 'adamant' }, bold: { name: 'bold' }, brave: { name: 'brave' }, calm: { name: 'calm' }, careful: { name: 'careful' }, gentle: { name: 'gentle' }, hardy: { name: 'hardy' }, hasty: { name: 'hasty' }, impish: { name: 'impish' }, jolly: { name: 'jolly' }, lax: { name: 'lax' }, lonely: { name: 'lonely' }, mild: { name: 'mild' }, modest: { name: 'modest' }, naive: { name: 'naive' }, naughty: { name: 'naughty' }, quiet: { name: 'quiet' }, rash: { name: 'rash' }, relaxed: { name: 'relaxed' }, sassy: { name: 'sassy' }, serious: { name: 'serious' }, timid: { name: 'timid' } }, NATURE_ZH),
  };
  return app.nameIndex;
}

function lookupId(kind, name) {
  if (!name) return null;
  const idx = buildNameIndex()[kind];
  if (!idx) return null;
  const k = foldName(name);
  return idx.get(k) || null;
}

// 把一条原始数据（JSON 或 CSV 的一行）解析成标准队伍成员
function resolveSet(raw) {
  if (!raw) return null;
  const sid = lookupId('species', raw.species || raw.speciesId || raw.name || raw['精灵'] || raw['名字'] || raw['宝可梦']);
  if (!sid || !app.dex.species[sid]) return null;
  const movesRaw = raw.moves || raw['招式'] || raw['技能'] || [];
  const arr = Array.isArray(movesRaw) ? movesRaw : String(movesRaw).split(/[\/,、;；|]/);
  const moves = [];
  for (const m of arr) {
    const id = lookupId('moves', String(m || '').trim());
    if (id && app.dex.moves[id] && !moves.includes(id)) moves.push(id);
    if (moves.length === 4) break;
  }
  const nature = lookupId('natures', raw.nature || raw['性格']) || 'hardy';
  return {
    speciesId: sid,
    moves,
    item: lookupId('items', raw.item || raw['道具']) || null,
    ability: lookupId('abilities', raw.ability || raw['特性']) || null,
    nature,
  };
}

function mergeLib(src) {
  if (!src) return 0;
  const list = Array.isArray(src) ? src : Object.values(src);
  let n = 0;
  for (const raw of list) {
    const s = resolveSet(raw);
    if (!s) continue;
    const old = app.lib[s.speciesId];
    // 信息更全的那份胜出（招式多的优先，其次道具/特性有值的优先）
    const better = !old
      || (s.moves || []).length > (old.moves || []).length
      || ((s.moves || []).length === (old.moves || []).length && !old.item && s.item);
    if (better) { app.lib[s.speciesId] = s; n++; }
  }
  return n;
}

function saveLib() {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(app.lib)); } catch (e) { /* ignore */ }
}

function forgetLib(sid) {
  if (!sid) return;
  delete app.lib[sid];
  apiGone.add(sid);
  saveLib();
  pushPoolToEngine();
  try {
    fetch('api/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speciesId: sid }),
    }).catch(() => {});
  } catch (e) { /* ignore */ }
  toast(`已从库里删除「${speciesName(app.dex, sid)}」`);
  render();
}

function loadLib() {
  try {
    const d = JSON.parse(localStorage.getItem(LIB_KEY) || 'null');
    if (d && typeof d === 'object') app.lib = d;
  } catch (e) { /* ignore */ }
}

// 这只精灵能不能学这招（形态会合并基础种的招式表；没有数据时一律放行）
const LEARN_CACHE = new Map();
function learnsetOf(speciesId) {
  if (LEARN_CACHE.has(speciesId)) return LEARN_CACHE.get(speciesId);
  const all = app.dex.learnsets || {};
  const want = new Set(all[speciesId] || []);
  const sp = app.dex.species[speciesId];
  if (sp && sp.baseSpecies) {
    const baseId = String(sp.baseSpecies).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const m of (all[baseId] || [])) want.add(m);
  }
  LEARN_CACHE.set(speciesId, want);
  return want;
}

function canLearn(speciesId, moveId) {
  const ls = learnsetOf(speciesId);
  if (!ls.size) return true;
  return ls.has(moveId);
}

// 让引擎知道池子里的固定配招（对手未知招式时直接用，而不是瞎猜）
function pushPoolToEngine() {
  const map = {};
  for (const [sid, set] of Object.entries(app.lib)) {
    if (set && set.moves && set.moves.length) map[sid] = set.moves.filter(Boolean);
  }
  setPoolMoves(map);
}

// 每把录入的精灵自动记进库里
function touchSet(set) {
  if (!set || !set.speciesId) return;
  if (!app.dirty) app.dirty = new Set();
  app.dirty.add(set.speciesId);
  if (!app.pushed) app.pushed = new Set();
  app.pushed.add(set.speciesId);   // 手动改过的以我为准，上传时覆盖服务器
}

function rememberTeam() {
  if (app.demo) return;   // 示例队伍不算真实数据
  let changed = false;
  for (const team of [app.my, app.opp]) {
    for (const set of team) {
      if (!set || !set.speciesId) continue;
      if (apiGone.has(set.speciesId)) continue;
      const moves = (set.moves || []).filter(Boolean);
      if (!moves.length) continue;
      const s = {
        speciesId: set.speciesId,
        moves,
        item: set.item || null,
        ability: set.ability || null,
        nature: set.nature || 'hardy',
      };
      const old = app.lib[s.speciesId];
      const same = old && JSON.stringify(old) === JSON.stringify(s);
      const dirty = app.dirty && app.dirty.has(s.speciesId);
      const better = !old
        || dirty
        || moves.length > (old.moves || []).length
        || (moves.length === (old.moves || []).length && !old.item && s.item);
      if (dirty) app.dirty.delete(s.speciesId);
      if (!same && better) { app.lib[s.speciesId] = s; changed = true; }
    }
  }
  if (changed) { saveLib(); pushPoolToEngine(); syncPush(); }
}

// 被删掉的精灵：本地和服务端都不再自动收录
const apiGone = new Set();

// ---- 和服务端同步（朋友之间共用一份数据） ----
let pushTimer = null;
function libForPush() {
  const out = {};
  for (const [sid, v] of Object.entries(app.lib || {})) if (!apiGone.has(sid)) out[sid] = v;
  return out;
}

function syncPush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await fetch('api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lib: libForPush(), overwrite: [...(app.pushed || [])] }),
      });
      app.cloud = 'ok';
    } catch (e) { app.cloud = 'off'; }
  }, 700);
}

async function syncPull() {
  try {
    const r = await fetch('api/state', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.lib) {
      const n = mergeLib(d.lib);
      let removed = 0;
      for (const sid of Object.keys(d.gone || {})) {
        if (app.lib[sid]) { delete app.lib[sid]; apiGone.add(sid); removed++; }
      }
      if (n || removed) { saveLib(); pushPoolToEngine(); }
      app.cloud = 'ok';
      // 本地已有的（别的设备/上次的）也送上去，保证大家的数据合在一起
      if (Object.keys(libForPush()).length) syncPush();
    }
  } catch (e) { app.cloud = 'off'; }
}

// 自动套用：选精灵时如果库里有这只，直接填好
function applyLib(set) {
  const known = app.lib[set.speciesId];
  if (!known) return false;
  set.moves = (known.moves || []).slice(0, 4);
  if (known.item) set.item = known.item;
  if (known.ability) set.ability = known.ability;
  if (known.nature) set.nature = known.nature;
  return true;
}

function libCount() { return Object.keys(app.lib || {}).length; }

// ---- 导入 / 导出 ----
function parseCsvSets(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cells = t.split(/[,\t]/).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^(精灵|宝可梦|species|name)$/i.test(cells[0])) continue; // 表头
    out.push({
      species: cells[0],
      moves: cells.slice(1, 5).filter(Boolean),
      item: cells[5] || null,
      ability: cells[6] || null,
      nature: cells[7] || null,
    });
  }
  return out;
}

function openDataModal(mode) {
  const lib = libCount();
  const body = `
    <div class="hint-sm">已记住 <b>${lib}</b> 只精灵的配招。每次录入游戏里的精灵，这里都会自动增加，
    下一把选到同一只会自动填好。${app.cloud === 'off' ? '（当前没连上服务端，数据只存在这台设备上）' : ''}</div>
    ${lib ? `<div class="field-label">已记住的配招（点 ✕ 删掉填错的）</div>
    <div class="list" id="libList">${Object.keys(app.lib).sort((a, b) => speciesName(app.dex, a).localeCompare(speciesName(app.dex, b), 'zh')).map((sid) => {
      const it = app.lib[sid] || {};
      const mv = (it.moves || []).map((m) => moveName(app.dex, m)).join(' / ');
      return `<div class="move-row">
        <div class="item grow" style="cursor:default">
          <div class="grow">
            <div class="t1">${esc(speciesName(app.dex, sid))}<small style="color:var(--dim);font-weight:400"> · ${(it.moves || []).length} 招</small></div>
            <div class="t2">${esc(mv || '（没有招式）')}</div>
          </div>
        </div>
        <button class="iconbtn" data-act="forget" data-sid="${esc(sid)}" title="删除这只">✕</button>
      </div>`;
    }).join('')}</div>` : ''}
    <div class="field-label">粘贴数据（JSON 或 CSV 都行）</div>
    <textarea id="dataText" rows="7" placeholder="CSV 每行：精灵,招式1,招式2,招式3,招式4,道具,特性,性格&#10;例如：烈咬陆鲨,地震,逆鳞,尖石攻击,剑舞,生命宝珠,沙隐,爽朗&#10;&#10;或者 JSON：[{&quot;species&quot;:&quot;garchomp&quot;,&quot;moves&quot;:[&quot;earthquake&quot;,&quot;outrage&quot;],&quot;item&quot;:&quot;lifeorb&quot;}]"></textarea>
    <div class="set-row" style="margin-top:8px">
      <button class="btn" id="btnPickFile">从文件读取</button>
      <button class="btn primary" id="btnImport">导入</button>
    </div>
    <input type="file" id="fileInput" accept=".json,.csv,.txt" hidden>
    <div class="field-label">导出（发给朋友 / 备份）</div>
    <div class="set-row">
      <button class="btn" id="btnExport">导出全部数据</button>
      <button class="btn" id="btnDownload">下载备份文件</button>
    </div>
    <div class="hint-sm" style="margin-top:10px">朋友打开同一个网址使用时，数据会自动合并，不用互传文件。</div>
    <div class="set-row" style="margin-top:14px">
      <button class="btn primary" data-act="close">关闭</button>
    </div>`;
  openModal('数据（精灵配招库）', body, {
    close: () => closeModal(),
    forget: (el) => { forgetLib(el.dataset.sid); openDataModal(); },
  });

  const ta = $('#dataText');
  $('#btnPickFile').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { ta.value = String(rd.result || ''); };
    rd.readAsText(f);
  };
  $('#btnImport').onclick = () => {
    const text = (ta.value || '').trim();
    if (!text) { toast('先粘贴或选择数据'); return; }
    let list = null;
    if (text[0] === '[' || text[0] === '{') {
      try {
        const j = JSON.parse(text);
        list = Array.isArray(j) ? j : (j.sets || j.lib || (j.sets ? j.sets : []));
      } catch (e) { toast('JSON 格式不对'); return; }
    } else {
      list = parseCsvSets(text);
    }
    if (!Array.isArray(list) || !list.length) { toast('没读到有效数据'); return; }
    for (const raw of list) {
      const s = resolveSet(raw);
      if (s) apiGone.delete(s.speciesId);
    }
    const n = mergeLib(list);
    saveLib();
    pushPoolToEngine();
    rememberTeam();
    syncPush();
    toast(`导入成功：新增 ${n} 只，库内共 ${libCount()} 只`);
    render();
    openDataModal();
  };
  $('#btnDownload').onclick = () => {
    const data = { v: 1, at: new Date().toISOString(), lib: app.lib, records: app.records || [] };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pokeassist-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('备份文件已下载');
  };
  $('#btnExport').onclick = () => {
    ta.value = JSON.stringify(Object.values(app.lib || {}), null, 1);
    ta.select();
  };
  const copyBtn = $('#btnCopy');
  if (copyBtn) copyBtn.onclick = async () => {
    const txt = JSON.stringify(Object.values(app.lib || {}), null, 1);
    ta.value = txt;
    try { await navigator.clipboard.writeText(txt); toast('已复制'); } catch (e) { ta.select(); toast('已全选，按 Ctrl+C'); }
  };
}

// ------------------------------------------------------------------ modal

let modalHandlers = {};

function openModal(title, html, handlers = {}) {
  modalHandlers = handlers || {};
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modalBody').scrollTop = 0;
  $('#modal').hidden = false;
}
function closeModal() {
  $('#modal').hidden = true;
  modalHandlers = {};
}

function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:#2a3142;' +
    'border:1px solid #3a4257;color:#e8ecf5;padding:9px 16px;border-radius:10px;font-size:13px;z-index:300;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.4)';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// ------------------------------------------------------------------ pickers

function openPicker(title, items, onPick, placeholder = '搜索名字…') {
  const body = `
    <input class="search" id="pkSearch" placeholder="${placeholder}" autocomplete="off" autocorrect="off" spellcheck="false">
    <div class="list" id="pkList"></div>`;
  openModal(title, body);
  const listEl = () => $('#pkList');
  const paint = (q) => {
    const ql = String(q || '').trim().toLowerCase();
    const f = ql ? items.filter((it) => String(it.search || '').includes(ql)) : items;
    const el = listEl();
    if (!f.length) { el.innerHTML = '<div class="empty-line">没有找到</div>'; return; }
    el.innerHTML = f.slice(0, 80).map((it) => `
      <button class="item" data-k="${esc(it.key)}">
        <div class="grow">
          <div class="t1">${esc(it.title)}</div>
          ${it.sub ? `<div class="t2">${it.sub}</div>` : ''}
        </div>
        ${it.right || ''}
      </button>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('[data-k]');
      if (b) onPick(b.dataset.k);
    };
  };
  const inp = $('#pkSearch');
  inp.oninput = () => paint(inp.value);
  paint('');
  setTimeout(() => inp.focus(), 50);
}

// 精灵选择
function openSpeciesPicker(side, idx) {
  const items = Object.entries(app.dex.species)
    .filter(([, sp]) => sp.num >= 1 && sp.num <= 649)
    .sort((a, b) => a[1].num - b[1].num)
    .map(([id, sp]) => {
      const zh = speciesName(app.dex, id);
      return {
        key: id,
        title: `${zh} · #${sp.num}`,
        sub: `${sp.name} · ${(sp.types || []).map((t) => TYPE_ZH[t] || t).join('/')}`,
        right: `<span>${typeChips(sp.types)}</span>`,
        search: `${zh} ${sp.name} ${id}`.toLowerCase(),
      };
    });
  openPicker('选择精灵', items, (id) => {
    app.demo = false;
    const team = side === 'mine' ? app.my : app.opp;
    const prev = team[idx];
    const set = blankSet(id);
    if (prev && prev.speciesId === id) { Object.assign(set, prev); }
    const filled = applyLib(set);
    team[idx] = set;
    save();
    if (filled) toast(`${speciesName(app.dex, id)}：已自动填入记住的配招`);
    openSetEditor(side, idx);
  });
}

// 招式选择
function openMovePicker(side, idx, slot) {
  const team = side === 'mine' ? app.my : app.opp;
  const set = team[idx];
  const learn = (app.dex.learnsets[set.speciesId] || []);
  const pool = Array.from(new Set(learn.concat(app.dex.moves ? Object.keys(app.dex.moves) : [])));
  const onlyLearn = new Set(learn);
  const items = [];
  for (const id of pool) {
    const m = app.dex.moves[id];
    if (!m) continue;
    const known = onlyLearn.has(id);
    items.push({
      key: id,
      title: moveName(app.dex, id),
      sub: `${m.type ? TYPE_ZH[m.type] : ''} · ${m.category === 'Status' ? '变化' : (m.category === 'Physical' ? '物理' : '特殊')}` +
        `${m.basePower ? ' · 威力 ' + m.basePower : ''}${m.accuracy && m.accuracy !== true ? ' · 命中 ' + m.accuracy : ''}` +
        `${known ? '' : ' · 非本系可学（随意填）'}`,
      right: m.type ? typeChip(m.type) : '',
      search: `${moveName(app.dex, id)} ${m.name} ${id}`.toLowerCase(),
      _known: known,
    });
  }
  items.sort((a, b) => (b._known ? 1 : 0) - (a._known ? 1 : 0));
  items.unshift({ key: '__clear__', title: '清空这一格', sub: '把这招去掉', search: 'qingkong clear 删除' });
  openPicker(`选择招式 · 第${slot + 1} 招`, items, (id) => {
    if (id === '__clear__') {
      const ms2 = (set.moves || []).filter(Boolean);
      const at = ms2.indexOf((set.moves || [])[slot]);
      if (at >= 0) ms2.splice(at, 1);
      set.moves = ms2;
      save();
      rememberTeam();
      openSetEditor(side, idx);
      return;
    }
    if (!onlyLearn.has(id)) {
      const mv = app.dex.moves[id] || {};
      openModal('这一招可能填错了', `
        <p style="margin:0 2px 10px;font-size:13px;line-height:1.6">
          <b>${esc(speciesName(app.dex, set.speciesId))}</b> 一般学不会「<b>${esc(moveName(app.dex, id))}</b>」${mv.type ? `（${TYPE_ZH[mv.type] || mv.type}）` : ''}。<br>
          确定要加进去吗？如果只是点错了，点「不加」。
        </p>
        <div class="set-row">
          <button class="btn" data-act="no">不加</button>
          <button class="btn primary" data-act="yes">确实是这样，加上</button>
        </div>`, {
        no: () => { closeModal(); openMovePicker(side, idx, slot); },
        yes: () => { closeModal(); doPickMove(id); },
      });
      return;
    }
    doPickMove(id);
  });

  function doPickMove(id) {
    const ms = (set.moves || []).filter(Boolean).slice(0, 6);
    while (ms.length < 4) ms.push(null);
    if (slot >= ms.length) { while (ms.length <= slot) ms.push(null); }
    for (let i = 0; i < 4; i++) if (i !== slot && ms[i] === id) ms[i] = null;
    ms[slot] = id;
    set.moves = ms;
    touchSet(set);
    save();
    openSetEditor(side, idx);
  }
}

// 任意招式（不限制该精灵能不能学）—— 给"对手用了没记录的招式"用
function openAnyMovePicker(title, onPick) {
  const items = Object.keys(app.dex.moves).map((id) => {
    const m = app.dex.moves[id];
    return {
      key: id,
      title: moveName(app.dex, id),
      sub: `${m.type ? TYPE_ZH[m.type] : ''} · ${m.category === 'Status' ? '变化' : (m.category === 'Physical' ? '物理' : '特殊')}` +
        `${m.basePower ? ' · 威力 ' + m.basePower : ''}`,
      right: m.type ? typeChip(m.type) : '',
      search: `${moveName(app.dex, id)} ${m.name || ''} ${id}`.toLowerCase(),
      _n: m.num || 9999,
    };
  }).sort((a, b) => a._n - b._n);
  openPicker(title, items, onPick);
}

function openItemPicker(side, idx) {
  const team = side === 'mine' ? app.my : app.opp;
  const set = team[idx];
  const order = new Map(COMMON_ITEMS.map((k, i) => [k, i]));
  const items = Object.entries(app.dex.items)
    .filter(([, it]) => !it.isNonstandard || true)
    .map(([id, it]) => ({
      key: id,
      title: itemName(app.dex, id),
      sub: it.shortDesc || it.desc || '',
      search: `${itemName(app.dex, id)} ${it.name || ''} ${id}`.toLowerCase(),
      _o: order.has(id) ? order.get(id) : 999,
    }))
    .sort((a, b) => a._o - b._o || a.title.localeCompare(b.title));
  items.unshift({ key: '', title: '不带道具', sub: '清空', search: 'none 不带 无', _o: -1 });
  openPicker('选择道具', items, (id) => {
    set.item = id || null;
    touchSet(set);
    const b = app.battle;
    if (b && b[side] && b[side][idx]) {
      b[side][idx].item = id || null;
      b[side][idx].itemInferred = false;
      recompute();
    }
    save();
    openSetEditor(side, idx);
  });
}

function openAbilityPicker(side, idx) {
  const team = side === 'mine' ? app.my : app.opp;
  const set = team[idx];
  const sp = app.dex.species[set.speciesId];
  const abil = Object.entries(sp.abilities || {});
  const items = abil.map(([k, name]) => {
    const id = normId(name);
    return {
      key: id,
      title: abilityName(app.dex, id),
      sub: `${name}${k === 'H' ? ' · 隐藏特性' : ''}`,
      search: `${abilityName(app.dex, id)} ${name} ${id}`.toLowerCase(),
    };
  });
  if (!items.length) { toast('这只精灵没有可选特性'); return; }
  openPicker('选择特性', items, (id) => {
    set.ability = id;
    touchSet(set);
    save();
    openSetEditor(side, idx);
  });
}

function openNaturePicker(side, idx) {
  const team = side === 'mine' ? app.my : app.opp;
  const set = team[idx];
  const NATURES = {
    hardy: [' hardy', '平衡'], lonely: ['', '攻↑ 防↓'], brave: ['', '攻↑ 速↓'], adamant: ['', '攻↑ 特攻↓'],
    naughty: ['', '攻↑ 特防↓'], bold: ['', '防↑ 攻↓'], docile: ['', '平衡'], relaxed: ['', '防↑ 速↓'],
    impish: ['', '防↑ 特攻↓'], lax: ['', '防↑ 特防↓'], timid: ['', '速↑ 攻↓'], hasty: ['', '速↑ 防↓'],
    serious: ['', '平衡'], jolly: ['', '速↑ 特攻↓'], naive: ['', '速↑ 特防↓'], modest: ['', '特攻↑ 攻↓'],
    mild: ['', '特攻↑ 防↓'], quiet: ['', '特攻↑ 速↓'], bashful: ['', '平衡'], rash: ['', '特攻↑ 特防↓'],
    calm: ['', '特防↑ 攻↓'], gentle: ['', '特防↑ 防↓'], sassy: ['', '特防↑ 速↓'], careful: ['', '特防↑ 特攻↓'],
    quirky: ['', '平衡'],
  };
  const ZH = { hardy: '勤奋', lonely: '怕寂寞', brave: '勇敢', adamant: '固执', naughty: '顽皮', bold: '大胆', docile: '坦率', relaxed: '悠闲', impish: '淘气', lax: '乐天', timid: '胆小', hasty: '急躁', serious: '认真', jolly: '爽朗', naive: '天真', modest: '内敛', mild: '慢吞吞', quiet: '冷静', bashful: '害羞', rash: '马虎', calm: '温和', gentle: '温顺', sassy: '自大', careful: '慎重', quirky: '浮躁' };
  const items = COMMON_NATURES.concat(Object.keys(NATURES).filter((n) => !COMMON_NATURES.includes(n)))
    .map((id) => ({
      key: id,
      title: ZH[id] || id,
      sub: (NATURES[id] || [])[1] || '平衡',
      search: `${ZH[id] || id} ${id}`.toLowerCase(),
    }));
  openPicker('选择性格', items, (id) => {
    set.nature = id;
    touchSet(set);
    save();
    openSetEditor(side, idx);
  });
}

// ------------------------------------------------------------------ set editor

function openSetEditor(side, idx) {
  const team = side === 'mine' ? app.my : app.opp;
  const set = team[idx];
  if (!set) return;
  const sp = app.dex.species[set.speciesId];
  const title = speciesName(app.dex, set.speciesId);
  const ms = (set.moves || []).filter(Boolean).slice(0, 6);
  while (ms.length < 4) ms.push(null);

  const moveRows = ms.map((id, i) => {
    const m = id ? app.dex.moves[id] : null;
    const odd = id && !canLearn(set.speciesId, id);
    return `<div class="move-row">
      <button class="item grow" data-act="move" data-i="${i}">
        <div class="grow">
          <div class="t1">${id ? esc(moveName(app.dex, id)) : '＋ 选择招式'}${odd ? ' <span class="badge warn">可能填错</span>' : ''}</div>
          <div class="t2">${m ? `${TYPE_ZH[m.type] || m.type} · ${m.category === 'Status' ? '变化' : (m.category === 'Physical' ? '物理' : '特殊')}${m.basePower ? ' · 威力 ' + m.basePower : ''}` : '第 ' + (i + 1) + ' 招'}</div>
        </div>
        ${m ? typeChip(m.type) : ''}
      </button>
      ${id ? `<button class="iconbtn" data-act="clearmove" data-i="${i}" title="删掉这一招">✕</button>` : ''}
    </div>`;
  }).join('');

  const abilId = set.ability || normId((sp.abilities || {})['0'] || (sp.abilities || {})['1'] || '');
  const itemId = set.item;
  const curMon = app.battle && app.battle[side] && app.battle[side][idx];
  const inferredItem = side === 'theirs' && !itemId && curMon && curMon.itemInferred ? curMon.item : null;

  openModal(title, `
    <div class="row wrap" style="margin-bottom:4px">${typeChips(sp.types)}
      <span class="chip">HP ${sp.baseStats.hp}</span>
      <span class="chip">攻 ${sp.baseStats.atk}</span>
      <span class="chip">防 ${sp.baseStats.def}</span>
      <span class="chip">特攻 ${sp.baseStats.spa}</span>
      <span class="chip">特防 ${sp.baseStats.spd}</span>
      <span class="chip">速 ${sp.baseStats.spe}</span>
    </div>
    <div class="field-label">招式（${ms.length} 格）</div>
    <div class="list">${moveRows}</div>
    <div class="field-label">特性</div>
    <button class="item" data-act="ability">
      <div class="grow"><div class="t1">${abilId ? esc(abilityName(app.dex, abilId)) : '未设置（用默认）'}</div>
      <div class="t2">${abilId ? esc(((sp.abilities || {})['0'] || (sp.abilities || {})['1'] || '')) : ''}</div></div>
    </button>
    <div class="field-label">道具</div>
    <button class="item" data-act="item">
      <div class="grow"><div class="t1">${itemId ? esc(itemName(app.dex, itemId)) : (inferredItem ? '推测：' + esc(itemName(app.dex, inferredItem)) : (side === 'mine' ? '不带道具' : '未知'))}</div>
      <div class="t2">${side === 'mine' ? '' : (inferredItem ? '按你库里这只以前带的道具推测，点一下可以改' : '不知道就留空，助手按无道具估算')}</div></div>
    </button>
    ${inferredItem ? '<button class="linkbtn" data-act="clearinfer">清除这个推测</button>' : ''}
    <div class="field-label">性格</div>
    <button class="item" data-act="nature">
      <div class="grow"><div class="t1">${esc(set.nature || 'hardy')}</div><div class="t2">随机对战通常是平衡性格，影响不大</div></div>
    </button>
    <div class="set-row" style="margin-top:16px">
      <button class="btn" data-act="clear">清空这只</button>
      <button class="btn primary" data-act="done">完成</button>
    </div>
  `, {
    move: (el) => openMovePicker(side, idx, Number(el.dataset.i)),
    clearmove: (el) => {
      touchSet(set);
      const i = Number(el.dataset.i);
      const list = (set.moves || []).filter(Boolean);
      const gone = (set.moves || [])[i];
      const at = gone ? list.indexOf(gone) : -1;
      if (at >= 0) list.splice(at, 1);
      set.moves = list;
      save();
      rememberTeam();
      openSetEditor(side, idx);
    },
    ability: () => openAbilityPicker(side, idx),
    item: () => openItemPicker(side, idx),
  clearinfer: () => {
    if (curMon) { curMon.item = null; curMon.itemInferred = false; }
    recompute();
    save();
    openSetEditor(side, idx);
  },
    nature: () => openNaturePicker(side, idx),
    clear: () => { team[idx] = null; save(); closeModal(); render(); },
    done: () => { closeModal(); render(); },
  });
}

// ------------------------------------------------------------------ setup render

function slotHTML(side, idx, set) {
  const no = `<div class="slot-no">${idx + 1}</div>`;
  if (!set) {
    return `<button class="slot is-empty" data-slot="${side}:${idx}">＋ 选择精灵</button>`;
  }
  const sp = app.dex.species[set.speciesId];
  const ms = (set.moves || []).filter(Boolean);
  const moveTxt = ms.length
    ? ms.map((id) => `<span class="mv"><i style="background:${TYPE_COLOR[(app.dex.moves[id] || {}).type] || '#555'}"></i>${esc(moveName(app.dex, id))}</span>`).join('')
    : '<span style="color:#6b7488;font-size:11px">未填招式</span>';
  const abil = set.ability || normId((sp.abilities || {})['0'] || (sp.abilities || {})['1'] || '');
  const meta = [
    set.item ? esc(itemName(app.dex, set.item)) : (side === 'mine' ? '无道具' : '道具未知'),
    abil ? esc(abilityName(app.dex, abil)) : '',
  ].filter(Boolean).join(' · ');
  return `<button class="slot" data-slot="${side}:${idx}">
    ${no}
    <div class="slot-body">
      <div class="slot-name">${esc(speciesName(app.dex, set.speciesId))} ${typeChips(sp.types)}</div>
      <div class="slot-meta">${meta}</div>
      <div class="slot-moves">${moveTxt}</div>
    </div>
  </button>`;
}

function renderSetup() {
  $('#mySlots').innerHTML = app.my.map((s, i) => slotHTML('mine', i, s)).join('');
  $('#oppSlots').innerHTML = app.opp.map((s, i) => slotHTML('opp', i, s)).join('');
  renderPoolRow();
}

// 已记住的精灵：点一下把整只（含 4 个招式）填进空位
function renderPoolRow() {
  const box = $('#poolRow');
  if (!box) return;
  const ids = Object.keys(app.lib || {})
    .filter((id) => app.dex.species[id] && (app.lib[id].moves || []).length)
    .sort((a, b) => app.dex.species[a].num - app.dex.species[b].num);
  const emptyCount = app.my.filter((s) => !s).length + app.opp.filter((s) => !s).length;
  if (!ids.length) {
    box.innerHTML = `<div class="pool-head">数据池
        <span><button class="btn-mini" data-act="ocr">识图</button>
        <button class="btn-mini" data-act="data">导入 / 管理</button></span></div>
      <div class="pool-empty">还没记住任何精灵。录入过的精灵会自动记在这里，下一局点一下就能整套填入。</div>`;
    return;
  }
  box.innerHTML = `<div class="pool-head">已记住 ${ids.length} 只 · 点一下整套填入（先我方，满了填对手）
      <span><button class="btn-mini" data-act="ocr">识图</button>
      <button class="btn-mini" data-act="data">管理</button></span></div>
    <div class="pool-chips">${ids.map((id) => `<button class="pchip" data-lib="${id}">${esc(speciesName(app.dex, id))}<i>${(app.lib[id].moves || []).length}</i></button>`).join('')}</div>`;
}

function fillFromLib(sid) {
  const order = ['mine', 'opp'];
  for (const side of order) {
    const team = side === 'mine' ? app.my : app.opp;
    const i = team.findIndex((s) => !s);
    if (i < 0) continue;
    const set = blankSet(sid);
    applyLib(set);
    team[i] = set;
    save();
    render();
    toast(`已填入${side === 'mine' ? '我方' : '对手'}第 ${i + 1} 格`);
    return true;
  }
  toast('两边都满了，先清掉一格');
  return false;
}

// ------------------------------------------------------------------ 识图（OCR）

let OCR_CARDS = [];

function fileToDataUrl(file, maxSide = 2000) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('图片读不出来'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片读不出来'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (scale >= 1) { resolve(fr.result); return; }
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/png'));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

async function ocrImage(dataUrl) {
  const res = await fetch('api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || '识别失败');
  return j.lines || [];
}

function openOcrModal() {
  openModal('识图填队', `
    <div class="hint-sm">游戏里按 <b>Win + Shift + S</b> 截一块（把精灵卡和招式截进去），
      然后在这个框里按 <b>Ctrl + V</b> 粘贴。手机上点下面按钮从相册选图。</div>
    <div class="ocr-drop" id="ocrDrop">
      <div class="pool-empty" id="ocrDropText">粘贴 / 拖入截图，或者</div>
      <button class="btn primary" id="ocrPick">选择图片</button>
      <input type="file" id="ocrFile" accept="image/*" hidden>
    </div>
    <div class="hint-sm" id="ocrBusy" hidden>正在识别，大概 2 秒…</div>
    <div id="ocrPreview"></div>
    <div id="ocrResult"></div>
    <div class="set-row" id="ocrActions" hidden>
      <button class="btn primary" data-ocr-all="auto">自动填入</button>
      <button class="btn" data-ocr-all="mine">都填我方</button>
      <button class="btn" data-ocr-all="opp">都填对方</button>
    </div>
    <div class="hint-sm" id="ocrNote" hidden></div>`, {});

  $('#ocrPick').onclick = () => $('#ocrFile').click();
  $('#ocrFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) await handleOcrFile(f);
  };
  const drop = $('#ocrDrop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('on'); };
  drop.ondragleave = () => drop.classList.remove('on');
  drop.ondrop = async (e) => {
    e.preventDefault();
    drop.classList.remove('on');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await handleOcrFile(f);
  };
  document.querySelectorAll('[data-ocr-all]').forEach((b) => {
    b.onclick = () => ocrFillAll(b.dataset.ocrAll);
  });
}

async function handleOcrFile(file) {
  if (!/^image\//.test(file.type || '')) { toast('这个不是图片'); return; }
  let dataUrl;
  try {
    dataUrl = await fileToDataUrl(file);
  } catch (e) {
    toast(e.message || '图片读不出来');
    return;
  }
  await handleOcrDataUrl(dataUrl);
}

async function handleOcrDataUrl(dataUrl) {
  const busy = $('#ocrBusy');
  const box = $('#ocrResult');
  if (busy) busy.hidden = false;
  if (box) box.innerHTML = '';
  const prev = $('#ocrPreview');
  if (prev) prev.innerHTML = `<img src="${dataUrl}" class="ocr-thumb" alt="">`;
  try {
    const lines = await ocrImage(dataUrl);
    OCR_CARDS = parseCards(app.dex, lines);
    renderOcr(OCR_CARDS, lines.length);
  } catch (e) {
    if (busy) busy.hidden = true;
    toast(e.message || '识别失败');
    if (box) box.innerHTML = `<div class="pool-empty">没识别出来。可能是截图太小、或者服务端没更新（重启一下黑窗口）。</div>`;
  }
}

function renderOcr(cards, lineCount) {
  const busy = $('#ocrBusy');
  if (busy) busy.hidden = true;
  const box = $('#ocrResult');
  const acts = $('#ocrActions');
  if (!box) return;
  if (!cards.length) {
    box.innerHTML = `<div class="pool-empty">读到 ${lineCount} 行文字，但没拼出精灵。截图里要有完整的精灵卡（名字 + 招式）才行。</div>`;
    if (acts) acts.hidden = true;
    return;
  }
  if (acts) acts.hidden = false;
  box.innerHTML = cards.map((c, i) => {
    const moves = (c.moves || []).map((m) => `<span class="chip">${esc(m.zh)}</span>`).join('') || '<span class="dim">没认出招式</span>';
    const meta = [
      c.itemZh ? `道具 ${esc(c.itemZh)}` : '',
      c.abilityZh ? `特性 ${esc(c.abilityZh)}` : '',
    ].filter(Boolean).join(' · ');
    const unk = (c.unknown || []).length ? `<div class="hint-sm">没认出来：${esc(c.unknown.join('、'))}</div>` : '';
    const weak = c.score < 70 ? '<span class="badge warn">名字不太确定</span>' : '';
    const dupOf = findSet(c.speciesId);
    const tgt = dupOf ? null : ocrTargetSide(c);
    const sideTag = dupOf
      ? `<span class="badge">已在${dupOf.side === 'mine' ? '我方' : '对方'}</span>`
      : `<span class="badge">→ ${tgt === 'mine' ? '我方' : '对手'}</span>`;
    return `<div class="ocr-card">
      <div class="ocr-title"><b>${esc(c.species || '?')}</b> ${weak} ${sideTag}</div>
      <div class="ocr-moves">${moves}</div>
      ${meta ? `<div class="hint-sm">${meta}</div>` : ''}
      ${unk}
      <div class="set-row" style="margin-top:8px">
        <button class="btn-mini" data-ocr-one="opp" data-i="${i}">填到对方</button>
        <button class="btn-mini" data-ocr-one="mine" data-i="${i}">填到我方</button>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-ocr-one]').forEach((b) => {
    b.onclick = () => {
      const card = OCR_CARDS[Number(b.dataset.i)];
      if (!card) return;
      if (ocrFillAt(card, b.dataset.ocrOne)) toast(`已填入${b.dataset.ocrOne === 'mine' ? '我方' : '对手'}`);
    };
  });
}

function ocrFillAt(card, side) {
  if (!card || !card.speciesId) { toast('这只没认准，先手动选一下'); return false; }
  const team = side === 'mine' ? app.my : app.opp;
  const i = team.findIndex((s) => !s);
  if (i < 0) return false;
  const set = blankSet(card.speciesId);
  set.moves = (card.moves || []).map((m) => m.id).filter(Boolean).slice(0, 4);
  if (card.itemId) set.item = card.itemId;
  if (card.abilityId) set.ability = card.abilityId;
  const known = app.lib[card.speciesId];
  if (known && known.nature) set.nature = known.nature;
  team[i] = set;
  save();
  render();
  return true;
}

// 这只该填哪边：优先看敌我队伍里是不是已经有它了
function ocrTargetSide(card) {
  if (app.ocrForce === 'mine' || app.ocrForce === 'opp') return app.ocrForce;
  const inMine = app.my.some((s) => s && s.speciesId === card.speciesId);
  const inOpp = app.opp.some((s) => s && s.speciesId === card.speciesId);
  if (inMine) return 'mine';
  if (inOpp) return 'opp';
  // 两张图的用法：第一张是"自己的详细队伍"，此时我方还没填满 → 先填我方；
  // 第二张对战图里我方已满 → 自动填对方。
  const mineFull = app.my.filter((x) => x && x.speciesId).length >= 4;
  if (!mineFull) return 'mine';
  return app.ocrLast || 'opp';
}

function findSet(speciesId) {
  const m = app.my.findIndex((s) => s && s.speciesId === speciesId);
  if (m >= 0) return { side: 'mine', idx: m };
  const o = app.opp.findIndex((s) => s && s.speciesId === speciesId);
  if (o >= 0) return { side: 'opp', idx: o };
  return null;
}

function ocrFillAll(force) {
  const list = (OCR_CARDS || []).filter((c) => c.speciesId);
  if (!list.length) { toast('没有可填的'); return; }
  app.ocrForce = force === 'auto' ? null : force;
  let n = 0;
  let dup = 0;
  let full = 0;
  for (const c of list) {
    if (findSet(c.speciesId)) { dup += 1; continue; }   // 敌我双方已有这只，不重复占位
    const side = ocrTargetSide(c);
    if (ocrFillAt(c, side)) { n += 1; app.ocrLast = side; } else full += 1;
  }
  save();
  const bits = [`填入 ${n} 只`];
  if (dup) bits.push(`${dup} 只敌我已有，跳过`);
  if (full) bits.push(`${full} 只没位置了`);
  toast(bits.join('，'));
  closeModal();
}

// ------------------------------------------------------------------ battle: build

// 对手道具看不到：按他池子里这只以前带过的来推测
// 每局结束的记录：用来统计"这只遇过几次""这招见过几次"
function seenCount(speciesId) {
  let n = 0;
  for (const r of app.records || []) {
    if ((r.opp || []).includes(speciesId)) n += 1;
  }
  return n;
}

function seenMoveCount(speciesId, moveId) {
  let n = 0;
  for (const r of app.records || []) {
    if (!(r.opp || []).includes(speciesId)) continue;
    const mv = (r.oppMoves || {})[speciesId];
    if (mv && mv.includes(moveId)) n += 1;
  }
  return n;
}

function copyText(txt) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt);
      toast('已复制：' + txt);
      return;
    }
  } catch (e) { /* ignore */ }
  const ta = document.createElement('textarea');
  ta.value = txt;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('已复制：' + txt); } catch (e) { toast('复制失败，手动长按复制'); }
  document.body.removeChild(ta);
}

async function openShareModal() {
  let info = null;
  try {
    info = await (await fetch('api/netinfo')).json();
  } catch (e) { info = null; }
  const lan = (info && info.lan) || [];
  const pub = info && info.public;
  const lanHtml = lan.length
    ? lan.map((u) => `<div class="share-url" data-copy="${esc(u)}">${esc(u)}</div>`).join('')
    : '<div class="hint">没找到局域网地址。确认电脑连着 WiFi / 网线。</div>';
  const pubHtml = pub
    ? `<div class="share-url" data-copy="${esc(pub)}">${esc(pub)}</div>
       <div class="hint">这是公网网址，手机流量、外网朋友都能打开。关掉分享窗口就失效。</div>`
    : `<div class="hint">还没开公网分享。要让「不在同一个 WiFi 的朋友」也能用：
       关掉现在的黑窗口，双击 <b>启动并分享.bat</b>，等它显示 https://… 的网址，那才是能发出去的链接。</div>`;
  openModal('分享给朋友 / 手机打开', `
    <div class="hint" style="margin:0 2px 10px">
      <b>127.0.0.1 只能你这台电脑自己用</b>——它是"本机"的意思，发给别人一定打不开。
    </div>
    <div class="sec-title">① 同一个 WiFi（最快）</div>
    ${lanHtml}
    <div class="hint">朋友和你连同一个路由器就能开；点网址会复制。</div>
    <div class="sec-title">② 不在同一个 WiFi（要公网网址）</div>
    ${pubHtml}
    <div class="sec-title">③ 现在你自己用的</div>
    <div class="share-url" data-copy="${esc((info && info.local) || 'http://127.0.0.1:8765/')}">${esc((info && info.local) || 'http://127.0.0.1:8765/')}</div>
    <div class="hint">大家的数据是同一份，存在你这台电脑上。</div>
    <div class="set-row" style="margin-top:14px"><button class="btn" data-act="cancel">关闭</button></div>
  `, {
    cancel: () => closeModal(),
  });
}

function openEndGameModal() {
  const s = app.battle;
  if (!s) { toast('还没开始对战'); return; }
  app._endRes = 'test';
  app._endWhy = '';
  const result = [
    { k: 'win', t: '我赢了' },
    { k: 'lose', t: '我输了' },
    { k: 'quit', t: '我投降了' },
    { k: 'test', t: '测试局 / 不算数' },
  ];
  const reasons = ['跑表不准（该打死的没死）', '录入不全', '网络/掉线', '对手太强', '其它'];
  openModal('结束本局', `
    <p class="hint" style="margin:0 2px 8px">记一下结果和原因。以后可以按"哪只精灵遇到过几次、常出什么招"来调权重。</p>
    <div class="field-label">结果</div>
    <div class="row wrap">${result.map((r) => `<button class="chip${r.k === 'test' ? ' sel' : ''}" data-act="res" data-k="${r.k}">${r.t}</button>`).join('')}</div>
    <div class="field-label">为什么结束</div>
    <div class="row wrap">${reasons.map((r) => `<button class="chip" data-act="why" data-k="${r}">${r}</button>`).join('')}</div>
    <div class="field-label">备注（可不填）</div>
    <input type="text" id="endNote" class="num-input" placeholder="比如：对面带了白色香草">
    <div class="set-row" style="margin-top:14px">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn primary" data-act="save">保存并结束</button>
    </div>
  `, {
    res: (el) => {
      app._endRes = el.dataset.k;
      el.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
      el.classList.add('sel');
    },
    why: (el) => {
      app._endWhy = el.dataset.k;
      el.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
      el.classList.add('sel');
    },
    cancel: () => closeModal(),
    save: () => {
      const oppMoves = {};
      for (const set of app.opp) {
        if (!set || !set.speciesId) continue;
        oppMoves[set.speciesId] = (set.moves || []).filter(Boolean);
      }
      app.records = app.records || [];
      app.records.push({
        at: Date.now(),
        turns: Math.max(0, app.turnNo - 1),
        result: app._endRes || 'test',
        reason: app._endWhy || '',
        note: ($('#endNote') && $('#endNote').value) || '',
        mine: app.my.filter((x) => x && x.speciesId).map((x) => x.speciesId),
        opp: app.opp.filter((x) => x && x.speciesId).map((x) => x.speciesId),
        oppMoves,
      });
      if (app.records.length > 200) app.records.shift();
      app.battle = null;
      app.history = [];
      app.ranked = [];
      app.choice = null;
      app.oppAction = null;
      app.tab = 'setup';
      save();
      closeModal();
      render();
      toast('已经记下来了');
    },
  });
}

function inferItem(speciesId) {
  const rec = app.lib[speciesId];
  return rec && rec.item ? rec.item : null;
}

function buildMons(side) {
  const team = side === 'mine' ? app.my : app.opp;
  const out = [];
  for (let i = 0; i < 4; i++) {
    const set = team[i];
    if (!set || !app.dex.species[set.speciesId]) continue;
    let item = set.item || null;
    let inferred = false;
    if (!item && side === 'theirs') {
      const guess = inferItem(set.speciesId);
      if (guess) { item = guess; inferred = true; }
    }
    const mon = createMon(app.dex, set.speciesId, {
      level: 75,
      nature: set.nature || 'hardy',
      moves: (set.moves || []).filter(Boolean),
      item,
      ability: set.ability || undefined,
      maxHp: set.maxHp || undefined,
      nickname: speciesName(app.dex, set.speciesId),
    });
    mon.itemInferred = inferred;
    out.push(mon);
  }
  return out;
}

function startBattle() {
  const mine = buildMons('mine');
  const theirs = buildMons('theirs');
  if (!mine.length) { toast('先填至少一只我方精灵'); return; }
  if (!theirs.length) { toast('至少填一只对手精灵'); return; }
  app.battle = newState(mine, theirs);
  app.logs = [];
  app.history = [];
  app.oppAction = null;
  app.turnNo = 1;
  app.tab = 'battle';
  recompute();
  render();
  save();
  toast('对战开始，祝好运！');
}

function newFoeSlot() {
  const slot = app.opp.findIndex((x) => !x || !x.speciesId);
  return slot;
}

function addNewOppMon(speciesId) {
  const s = app.battle;
  if (!s) return;
  const slot = newFoeSlot();
  if (slot < 0) { toast('对手 4 只已经都记下了'); return; }
  const set = blankSet(speciesId);
  applyLib(set);
  app.opp[slot] = set;
  let guess = set.item || null;
  let inferred = false;
  if (!guess) { const g = inferItem(speciesId); if (g) { guess = g; inferred = true; } }
  const mon = createMon(app.dex, speciesId, {
    level: 75,
    nature: set.nature || 'hardy',
    moves: (set.moves || []).filter(Boolean),
    item: guess,
    ability: set.ability || undefined,
    maxHp: set.maxHp || undefined,
    nickname: speciesName(app.dex, speciesId),
  });
  mon.itemInferred = inferred;
  s.theirs.push(mon);
  const idx = s.theirs.length - 1;
  s.onField.theirs = s.onField.theirs.filter((i) => s.theirs[i] && !s.theirs[i].fainted);
  if (s.onField.theirs.length < 3) s.onField.theirs.push(idx);
  else s.bench.theirs = idx;
  s.active.theirs = idx;
  closeModal();
  rememberTeam();
  recompute();
  render();
  save();
  toast(`${mon.name} 记下了`);
}

function openAddFoeModal() {
  const used = new Set(app.opp.filter((x) => x && x.speciesId).map((x) => x.speciesId));
  const ids = Object.keys(app.lib).filter((id) => !used.has(id) && app.dex.species[id]).slice(0, 12);
  const chips = ids.map((id) => {
    const n = seenCount(id);
    return `<button class="chip" data-act="addfoe" data-id="${id}">${esc(speciesName(app.dex, id))}${n ? ' <i>遇过' + n + '</i>' : ''}</button>`;
  }).join('');
  openModal('对手换上了哪只？', `
    <p class="hint" style="margin:0 2px 10px">对手场上 3 只里挂了一只，他必须换第 4 只出来。记下来助手才能继续算。</p>
    ${chips ? `<div class="oe-sep">你库里还没用过的</div><div class="row wrap">${chips}</div>` : ''}
    <button class="item" data-act="search"><div class="grow"><div class="t1">从全部精灵里选</div><div class="t2">库里没有的新精灵</div></div></button>
    <button class="item" data-act="skip"><div class="grow"><div class="t1">先不填</div><div class="t2">他还没换出来</div></div></button>
  `, {
    addfoe: (el) => addNewOppMon(el.dataset.id),
    search: () => {
      const items = Object.keys(app.dex.species)
        .filter((id) => app.dex.species[id].num > 0)
        .sort((a, b) => app.dex.species[a].num - app.dex.species[b].num)
        .map((id) => ({
          key: id,
          title: speciesName(app.dex, id),
          sub: (app.dex.species[id].types || []).map((t) => TYPE_ZH[t] || t).join(' / '),
          search: `${speciesName(app.dex, id)} ${app.dex.species[id].name} ${id}`.toLowerCase(),
        }));
      openPicker('对手换上了哪只？', items, (id) => addNewOppMon(id));
    },
    skip: () => closeModal(),
  });
}

function recompute() {
  if (!app.battle) { app.ranked = []; app.choice = null; return; }
  app.ranked = rankActions(app.dex, app.battle);
  const keep = app.choice && app.ranked.find((r) => sameAction(r.action, app.choice));
  app.choice = keep ? app.choice : (app.ranked.length ? app.ranked[0].action : null);
}

function sameAction(a, b) {
  if (!a || !b) return false;
  return a.type === b.type && a.mon === b.mon && (a.moveId || '') === (b.moveId || '');
}

// ------------------------------------------------------------------ battle: render

function monCardHTML(side, idx) {
  const s = app.battle;
  const mon = s[side][idx];
  if (!mon) return '';
  const pct = clamp(Math.round((mon.hp / mon.maxHp) * 100), 0, 100);
  const isActive = s.active[side] === idx;
  const parts = [];
  if (mon.status) parts.push(`<span class="badge b-${mon.status}">${STATUS_ZH[mon.status] || mon.status}</span>`);
  for (const [k, v] of Object.entries(mon.boosts || {})) {
    if (!v) continue;
    parts.push(`<span class="badge ${v > 0 ? 'b-boost' : 'b-drop'}">${STAT_ZH[k]}${v > 0 ? '+' : ''}${v}</span>`);
  }
  if (mon.volatiles && mon.volatiles.substitute) parts.push('<span class="badge">替身</span>');
  return `<button class="mon-card ${isActive ? 'act' : ''} ${isAlive(mon) ? '' : 'dead'}" data-mon="${side}:${idx}">
    <div class="mc-top"><span class="mc-name">${esc(mon.name)}</span></div>
    <div class="types">${typeChips(mon.types)}</div>
    <div class="mc-item">${mon.item ? (mon.itemInferred ? '推测：' : '') + esc(itemName(app.dex, mon.item)) : '<i>道具未知</i>'}</div>
    <div class="hpbar"><i style="width:${pct}%;background:${hpColor(pct)}"></i></div>
    <div class="hpnum"><span>${pct}%</span><span>${mon.hp}/${mon.maxHp}</span></div>
    <div class="badges">${parts.join('')}</div>
  </button>`;
}

function benchHTML(side) {
  const s = app.battle;
  const b = s.bench[side];
  if (b === undefined || b < 0 || !s[side][b]) return '';
  const mon = s[side][b];
  const pct = clamp(Math.round((mon.hp / mon.maxHp) * 100), 0, 100);
  return `<div class="bench-dots">
    <span>场下：</span>
    <button class="mv" data-mon="${side}:${b}" style="border-color:#3a4257">
      <i style="background:${isAlive(mon) ? hpColor(pct) : '#555'}"></i>${esc(mon.name)} ${pct}%
    </button>
  </div>`;
}

function recoCardHTML(r, i) {
  const a = r.action;
  const s = app.battle;
  const p = clamp(Math.round(r.score * 100), 0, 100);
  const sel = sameAction(app.choice, a);
  let act = '', sub = '';
  if (a.type === 'move') {
    const mon = s.mine[a.mon];
    const m = app.dex.moves[a.moveId] || {};
    act = `${esc(mon.name)} · <b>${esc(moveName(app.dex, a.moveId))}</b> ${m.type ? typeChip(m.type) : ''}`;
    const ds = damagesAgainst(app.dex, s, a);
    const bits = [];
    if (m.category === 'Status') {
      bits.push('辅助招式 · 不造成伤害');
      if (m.accuracy && m.accuracy !== true && m.accuracy < 100) bits.push(`命中 ${m.accuracy}%`);
    } else if (ds.length) {
      const b = ds[0];
      if (b.immune) bits.push('<span class="warn">对 ' + esc(b.foe.name) + ' 无效</span>');
      else {
        bits.push(`对 ${esc(b.foe.name)} <b>${b.pctMin}–${b.pctMax}%</b>`);
        if (b.ko) bits.push('<span class="pos">可击杀</span>');
        else if (b.koProb >= 0.05) bits.push(`<span class="warn">击杀 ${Math.round(b.koProb * 100)}%</span>`);
        if (b.eff > 1) bits.push(`<span class="pos">克制×${b.eff}</span>`);
        else if (b.eff < 1) bits.push(`<span class="neg">抵抗×${b.eff}</span>`);
      }
      if (m.accuracy && m.accuracy !== true && m.accuracy < 100) bits.push(`命中 ${m.accuracy}%`);
      const mySpe = speedOf(s, 'mine', mon);
      const foeSpe = speedOf(s, 'theirs', b.foe);
      bits.push(mySpe >= foeSpe ? '<span class="pos">先手</span>' : '<span class="warn">后手</span>');
      if (ds.length > 1) bits.push(`另 ${ds.length - 1} 只`);
    } else {
      bits.push('变化招式');
    }
    sub = bits.join(' ');
  } else {
    const mon = s.mine[a.mon];
    act = `换上 <b>${esc(mon.name)}</b>`;
    sub = '消耗本回合 · 不攻击 · 对手会打它';
  }
  return `<button class="reco-card ${sel ? 'sel' : ''}" data-reco="${i}">
    <div class="reco-prob"><b>${p}</b><small>胜率</small></div>
    <div class="reco-main">
      <div class="reco-act">${act}</div>
      <div class="reco-sub">${sub}</div>
    </div>
  </button>`;
}

function renderBattle() {
  const s = app.battle;
  $('#emptyBattle').hidden = !!s;
  $('#battleBody').hidden = !s;
  if (!s) return;

  const over = aliveCount(s.mine) === 0 || aliveCount(s.theirs) === 0;
  $('#oppRow').innerHTML = s.onField.theirs.map((i) => monCardHTML('theirs', i)).join('') + benchHTML('theirs');
  $('#myRow').innerHTML = s.onField.mine.map((i) => monCardHTML('mine', i)).join('') + benchHTML('mine');
  $('#oppAliveLabel').textContent = `${aliveCount(s.theirs)}/${s.theirs.length} 存活`;
  $('#myAliveLabel').textContent = `${aliveCount(s.mine)}/${s.mine.length} 存活`;

  const box = $('#recoBox');
  if (over) {
    const win = aliveCount(s.theirs) === 0;
    box.innerHTML = `<div class="reco-card sel" style="justify-content:center">
      <div class="reco-main" style="text-align:center">
        <div class="reco-act" style="justify-content:center;font-size:16px">${win ? '🎉 赢了！' : '💀 输了…'}</div>
        <div class="reco-sub" style="justify-content:center">点右上角 ☰ 可以开始新的一场</div>
      </div></div>`;
    $('#btnResolve').disabled = true;
    $('#btnOppAction').disabled = true;
  } else {
    $('#btnResolve').disabled = false;
    $('#btnOppAction').disabled = false;
    const top = app.ranked.slice(0, 3);
    const chosen = app.ranked.findIndex((r) => sameAction(r.action, app.choice));
    if (chosen >= 3) top.push(app.ranked[chosen]);
    box.innerHTML = `
      <div class="reco-head"><b>推荐</b><small>${app.ranked.length} 个可选出招</small></div>
      ${top.map((r) => recoCardHTML(r, app.ranked.indexOf(r))).join('')}
      <button class="reco-more" id="btnAllActions">查看全部 ${app.ranked.length} 个选择 ›</button>`;
  }

  // 天气 / 回合
  const tb = $('#turnBox');
  const w = s.field && s.field.weather;
  tb.innerHTML = `<span class="tb">第 ${app.turnNo} 回合</span>` +
    (w ? `<span class="tb">${WEATHER_ZH[w] || w}</span>` : '');

  // 对手出招标签
  const lbl = $('#oppActionLabel');
  if (app.oppAction) {
    lbl.textContent = foeActionLabel(app.oppAction);
  } else {
    lbl.textContent = '自动（最坏）';
  }
  const om = $('#btnOppMove');
  if (om) {
    om.textContent = app.oppAction
      ? `对手：${shortActionLabel(app.oppAction)} ▾`
      : '对手出招 ▾';
  }
  const gt = $('#guideTip');
  if (gt) gt.hidden = !!app.guideOff;

  renderLog();
}

function foeActionLabel(a) {
  const s = app.battle;
  if (!a || !s) return '';
  if (a.type === 'switch') return `换上 ${s.theirs[a.mon] ? s.theirs[a.mon].name : ''}`;
  const f = s.theirs[a.mon];
  return `${f ? f.name : ''}·${moveName(app.dex, a.moveId)}`;
}

function shortActionLabel(a) {
  const s = app.battle;
  if (!a || !s) return '';
  if (a.type === 'switch') return `换上 ${s.theirs[a.mon] ? s.theirs[a.mon].name : ''}`;
  return moveName(app.dex, a.moveId);
}

function actionLabel(a) {
  const s = app.battle;
  if (!a) return '';
  if (a.type === 'switch') return `换上 ${s.mine[a.mon].name}`;
  const m = s.mine[a.mon];
  return `${m ? m.name : ''}·${moveName(app.dex, a.moveId)}`;
}

function renderLog() {
  const el = $('#battleLog');
  if (!app.logs.length) { el.innerHTML = ''; return; }
  const items = app.logs.slice(-6).map((g) => `
    <div class="log-turn">— 第 ${g.turn} 回合 —</div>
    ${g.lines.map((l) => `<div class="log-line">${esc(l)}</div>`).join('')}
  `).join('');
  el.innerHTML = items;
}

// ------------------------------------------------------------------ battle: actions

function worstOppAction(dex, s, myAction) {
  const acts = oppActions(dex, s);
  if (!acts.length) return null;
  let best = acts[0], bestV = Infinity;
  for (const o of acts) {
    const r = resolveTurn(dex, s, myAction, o);
    const v = evaluate(r.state);
    if (v < bestV) { bestV = v; best = o; }
  }
  return best;
}

function doResolve() {
  const s = app.battle;
  if (!s || !app.choice) return;
  if (aliveCount(s.mine) === 0 || aliveCount(s.theirs) === 0) return;
  const oppAction = app.oppAction || worstOppAction(app.dex, s, app.choice);
  if (!oppAction) { toast('对手没有可用动作'); return; }
  const prevOppAlive = aliveCount(s.theirs);
  const snapshot = JSON.parse(JSON.stringify(s));
  const r = resolveTurn(app.dex, s, app.choice, oppAction);
  app.history.push({ state: snapshot, choice: app.choice, oppAction });
  if (app.history.length > 12) app.history.shift();
  app.battle = r.state;
  if (app.battle.log && app.battle.log.length > 80) app.battle.log = app.battle.log.slice(-80);
  app.logs.push({ turn: app.turnNo, lines: r.log.slice() });
  if (app.logs.length > 40) app.logs.shift();
  app.turnNo += 1;
  app.oppAction = null;
  app.choice = null;
  recompute();
  render();
  if (prevOppAlive > 0 && aliveCount(app.battle.theirs) < prevOppAlive && newFoeSlot() >= 0) {
    setTimeout(() => { if (app.battle && newFoeSlot() >= 0) openAddFoeModal(); }, 350);
  }
  save();
}

function undo() {
  if (!app.history.length) { toast('没有可撤销的回合'); return; }
  const h = app.history.pop();
  app.battle = h.state;
  app.turnNo = Math.max(1, app.turnNo - 1);
  app.logs.pop();
  app.oppAction = null;
  recompute();
  render();
  save();
}

// 对手出招选择
function commitFoeMove(idx, moveId) {
  closeModal();
  const set = app.opp[idx];
  if (set && moveId) {
    const ms = (set.moves || []).filter(Boolean);
    if (!ms.includes(moveId)) {
      ms.push(moveId);
      set.moves = ms.slice(-6);
    }
    rememberTeam();
  }
  app.oppAction = { type: 'move', mon: idx, moveId };
  recompute();
  render();
  save();
  toast(`已记下：对手用了「${moveName(app.dex, moveId)}」`);
}

function askWhichFoe(s, moveId) {
  const foes = s.onField.theirs.filter((i) => isAlive(s.theirs[i]));
  openModal('是哪只用的这招？', `<div class="list">${foes.map((i) => `
    <button class="item" data-act="pick" data-i="${i}">
      <div class="grow"><div class="t1">${esc(s.theirs[i].name)}</div>
      <div class="t2">HP ${Math.round(100 * s.theirs[i].hp / s.theirs[i].maxhp)}%${(app.opp[i] && (app.opp[i].moves || []).includes(moveId)) ? ' · 他的配招里有这招' : ''}</div></div></button>`).join('')}</div>`,
  { pick: (el) => commitFoeMove(Number(el.dataset.i), moveId) });
}

function suggestFoeMoves(mon) {
  if (!mon) return [];
  const known = new Set(mon.moves || []);
  const libSet = app.lib[mon.speciesId];
  const out = [];
  if (libSet && libSet.moves) {
    for (const id of libSet.moves) if (id && !known.has(id) && app.dex.moves[id] && !out.includes(id)) out.push(id);
  }
  // 池子里没参考就退回"这只能学的高威力招"
  if (!out.length) {
    const learn = app.dex.learnsets[mon.speciesId] || [];
    const cands = learn
      .filter((id) => !known.has(id) && app.dex.moves[id] && app.dex.moves[id].category !== 'Status')
      .sort((a, b) => (app.dex.moves[b].basePower || 0) - (app.dex.moves[a].basePower || 0));
    for (const id of cands) { if (out.length >= 6) break; out.push(id); }
  }
  return out.slice(0, 8);
}

function openOppActionModal() {
  const s = app.battle;
  if (!s) return;
  const acts = oppActions(app.dex, s);
  const foeIdx = s.active.theirs;
  const sug = suggestFoeMoves(s.theirs[foeIdx]);
  const rows = acts.map((a, i) => {
    const mon = s.theirs[a.mon];
    if (a.type === 'switch') {
      return `<button class="item" data-act="pick" data-i="${i}">
        <div class="grow"><div class="t1">换上 ${esc(mon.name)}</div><div class="t2">对手换人</div></div></button>`;
    }
    const m = app.dex.moves[a.moveId] || {};
    return `<button class="item" data-act="pick" data-i="${i}">
      <div class="grow">
        <div class="t1">${esc(mon.name)} · ${esc(moveName(app.dex, a.moveId))}</div>
        <div class="t2">${a.synthetic ? '没记录过（估算）' : '已记录'} · ${m.basePower ? '威力 ' + m.basePower : '变化'}${seenMoveCount(s.theirs[a.mon].speciesId, a.moveId) ? ' · 见过 ' + seenMoveCount(s.theirs[a.mon].speciesId, a.moveId) + ' 次' : ''}</div>
      </div>
      ${m.type ? typeChip(m.type) : ''}
    </button>`;
  }).join('');
  openModal('对手这回合出什么？', `
    <p class="hint" style="margin:0 2px 10px">不确定就选「自动」，助手会按对你最不利的可能来算。</p>
    <button class="item" data-act="auto"><div class="grow"><div class="t1">自动（最坏情况）</div><div class="t2">把每个可能都算一遍，取最差</div></div></button>
    <button class="item" data-act="manual"><div class="grow"><div class="t1">＋ 直接选一个招式</div><div class="t2">他出了没记录过的招？点这里现选，会自动记进他的配招</div></div></button>
    ${foeIdx !== null && sug.length ? `<div class="oe-sep">${esc(s.theirs[foeIdx].name)} 可能还有这些招（池子里见过的）</div>
      <div class="row wrap">${sug.map((id) => `<button class="chip" data-act="quickmove" data-id="${id}" data-mon="${foeIdx}">${esc(moveName(app.dex, id))}</button>`).join('')}</div>` : ''}
    <div class="oe-sep">或者从他们已知的招式里选</div>
    <div class="list">${rows}</div>
  `, {
    auto: () => { app.oppAction = null; closeModal(); render(); save(); },
    pick: (el) => { app.oppAction = acts[Number(el.dataset.i)]; closeModal(); render(); save(); },
    quickmove: (el) => commitFoeMove(Number(el.dataset.mon), el.dataset.id),
    manual: () => {
      const foes = s.onField.theirs.filter((i) => isAlive(s.theirs[i]));
      if (!foes.length) { toast('对手场上没有精灵'); return; }
      openAnyMovePicker('对手用了什么招式？', (moveId) => {
        const movers = foes.filter((i) => ((app.opp[i] && app.opp[i].moves) || []).includes(moveId));
        if (movers.length === 1) { commitFoeMove(movers[0], moveId); return; }
        const act = s.active ? s.active.theirs : null;
        if (foes.length === 1 || (act !== null && foes.includes(act))) {
          commitFoeMove(foes.length === 1 ? foes[0] : act, moveId);
          return;
        }
        askWhichFoe(s, moveId);
      });
    },
  });
}

// 全部可选动作
function openAllActions() {
  const ranked = app.ranked;
  const rows = ranked.map((r, i) => {
    const a = r.action;
    let t1 = '', t2 = '';
    if (a.type === 'move') {
      const mon = app.battle.mine[a.mon];
      const ds = damagesAgainst(app.dex, app.battle, a);
      const b = ds[0];
      t1 = `${esc(mon.name)} · ${esc(moveName(app.dex, a.moveId))}`;
      const mv = app.dex.moves[a.moveId] || {};
      t2 = mv.category === 'Status'
        ? '辅助招式'
        : (b ? (b.immune ? `对 ${b.foe.name} 无效` : `对 ${b.foe.name} ${b.pctMin}–${b.pctMax}%`) : '变化招式');
    } else {
      t1 = `换下场上 → 换上 ${esc(app.battle.mine[a.mon].name)}`;
      t2 = '消耗本回合';
    }
    return `<button class="item ${sameAction(app.choice, a) ? 'sel' : ''}" data-act="pick" data-i="${i}">
      <div class="grow"><div class="t1">${t1}</div><div class="t2">${t2}</div></div>
      <div style="font-weight:700;font-size:15px;color:#4f8cff">${Math.round(r.score * 100)}</div>
    </button>`;
  }).join('');
  openModal('全部出招选择', `<div class="list">${rows}</div>`, {
    pick: (el) => {
      app.choice = ranked[Number(el.dataset.i)].action;
      closeModal();
      render();
    },
  });
}

// 血量/状态修正
function openMonEditor(side, idx) {
  const s = app.battle;
  const mon = s[side][idx];
  if (!mon) return;
  const pct = clamp(Math.round((mon.hp / mon.maxHp) * 100), 0, 100);
  const isMine = side === 'mine';

  const moveBtns = isMine
    ? (mon.moves || []).filter(Boolean).map((id) => {
      const m = app.dex.moves[id] || {};
      return `<button class="item" data-act="use" data-mv="${esc(id)}">
        <div class="grow"><div class="t1">用 ${esc(moveName(app.dex, id))}</div>
        <div class="t2">${m.basePower ? '威力 ' + m.basePower : '变化招式'}</div></div>${m.type ? typeChip(m.type) : ''}</button>`;
    }).join('')
    : '<p class="hint">对手的招式不知道就空着，助手会按最强招估算。</p>';

  const revealBtns = !isMine
    ? (mon.moves || []).filter(Boolean).map((id) => `<span class="mv">${esc(moveName(app.dex, id))}</span>`).join('') ||
      '<span class="hint">还没有记录招式</span>'
    : '';

  const statusBtns = ['', 'brn', 'par', 'psn', 'tox', 'slp', 'frz'].map((st) =>
    `<button class="chip ${mon.status === (st || null) ? 'sel' : ''}" data-act="status" data-st="${st}">${st ? STATUS_ZH[st] : '正常'}</button>`).join('');

  openModal(`${mon.name} · 修正`, `
    <div class="hp-big"><b id="hpPct">${pct}</b>% · <span id="hpAbs">${mon.hp}</span> / ${mon.maxHp}</div>
    <div class="field-label">满血值（游戏里这只的最大血量，填了算得更准）</div>
    <input type="number" id="hpMax" class="num-input" min="1" max="999" value="${mon.maxHp}">
    <input type="range" id="hpRange" min="0" max="100" step="1" value="${pct}">
    <div class="row wrap" style="margin-top:6px">
      ${[0, 20, 33, 50, 75, 100].map((v) => `<button class="chip" data-act="quick" data-v="${v}">${v}%</button>`).join('')}
    </div>
    <div class="field-label">道具</div>
    <button class="item" data-act="item3">
      <div class="grow"><div class="t1">${mon.item ? (mon.itemInferred ? '推测：' : '') + esc(itemName(app.dex, mon.item)) : '未知'}</div>
      <div class="t2">${mon.itemInferred ? '按你库里这只以前带的道具推测，点一下改成真实道具' : '点一下可以改'}</div></div>
    </button>
    <div class="field-label">状态</div>
    <div class="row wrap">${statusBtns}</div>
    ${isMine ? `<div class="field-label">这个回合用它出招</div><div class="list">${moveBtns}</div>` : ''}
    ${!isMine ? `<div class="field-label">已暴露的招式</div><div class="row wrap">${revealBtns}</div>
      <button class="btn block" data-act="addmove" style="margin-top:8px">＋ 记录一个对手招式</button>` : ''}
    <div class="set-row" style="margin-top:14px">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn primary" data-act="save">保存</button>
    </div>
  `, {
    quick: (el) => {
      const v = Number(el.dataset.v);
      $('#hpRange').value = v;
      updateHpLabel(mon, v);
    },
    item3: () => {
      const setRef = (side === 'mine' ? app.my : app.opp)[idx];
      if (setRef && setRef.speciesId) openItemPicker(side, idx, () => openMonEditor(side, idx));
      else toast('这只是临时加的，先保存一次再改道具');
    },
    status: (el) => {
      mon.status = el.dataset.st || null;
      el.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
      el.classList.add('sel');
    },
    use: (el) => {
      const mv = el.dataset.mv;
      if (!s.onField.mine.includes(idx)) { toast('这只不在场上，请先轮转上场'); return; }
      app.choice = { type: 'move', mon: idx, moveId: mv };
      closeModal();
      render();
    },
    addmove: () => {
      const learn = app.dex.learnsets[mon.speciesId] || [];
      const items = learn.map((id) => {
        const m = app.dex.moves[id] || {};
        return {
          key: id,
          title: moveName(app.dex, id),
          sub: `${TYPE_ZH[m.type] || ''}${m.basePower ? ' · 威力 ' + m.basePower : ''}`,
          right: m.type ? typeChip(m.type) : '',
          search: `${moveName(app.dex, id)} ${m.name || ''} ${id}`.toLowerCase(),
        };
      });
      openPicker('记录对手的招式', items, (id) => {
        mon.moves = mon.moves || [];
        if (!mon.moves.includes(id) && mon.moves.length < 4) mon.moves.push(id);
        recompute();
        save();
        openMonEditor(side, idx);
      });
    },
    cancel: () => closeModal(),
    save: () => {
      const v = Number($('#hpRange').value);
      const newMax = Math.round(Number(($('#hpMax') || {}).value) || 0);
      const setRef = (side === 'mine' ? app.my : app.opp)[idx];
      if (newMax > 0 && newMax !== mon.maxHp) {
        mon.maxHp = newMax;
        mon.stats.hp = newMax;
        if (setRef && setRef.speciesId) { setRef.maxHp = newMax; }
      }
      mon.hp = Math.round((v / 100) * mon.maxHp);
      mon.fainted = mon.hp <= 0;
      if (mon.fainted) { mon.hp = 0; mon.volatiles = {}; mon.boosts = {}; }
      ensureActive(s, 'mine');
      ensureActive(s, 'theirs');
      promoteBench(s, 'mine');
      promoteBench(s, 'theirs');
      recompute();
      closeModal();
      render();
      save();
    },
  });

  const range = $('#hpRange');
  range.oninput = () => updateHpLabel(mon, Number(range.value));
  updateHpLabel(mon, pct);
}

function updateHpLabel(mon, pct) {
  $('#hpPct').textContent = pct;
  $('#hpAbs').textContent = Math.round((pct / 100) * mon.maxHp);
}

// ------------------------------------------------------------------ render root

function render() {
  $('#viewSetup').hidden = app.tab !== 'setup';
  $('#viewBattle').hidden = app.tab !== 'battle';
  $('#viewHelp').hidden = app.tab !== 'help';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === app.tab));
  if (app.tab === 'setup') renderSetup();
  if (app.tab === 'battle') renderBattle();
}

// ------------------------------------------------------------------ events

async function checkVersion() {
  try {
    const r = await fetch('api/version', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (!app.ver) { app.ver = d.v; return; }
    if (d.v && d.v !== app.ver) {
      const el = $('#updBanner');
      if (el) el.classList.remove('hidden');
    }
  } catch (e) { /* 离线就忽略 */ }
}

function bindEvents() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('input, textarea')) return;
    if (document.querySelector('#modalBody') && !document.querySelector('#modal').hidden) return;
    if (app.tab !== 'battle' || !app.battle) return;
    if (e.key === 'Enter') { e.preventDefault(); doResolve(); return; }
    if (e.key >= '1' && e.key <= '3') {
      const r = app.ranked[Number(e.key) - 1];
      if (r) { app.choice = r.action; render(); }
    }
  });
  // 标签切换
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { app.tab = t.dataset.tab; render(); return; }
  });

  // 队伍槽位
  $('#mySlots').addEventListener('click', (e) => {
    const el = e.target.closest('[data-slot]');
    if (!el) return;
    const [side, idx] = el.dataset.slot.split(':');
    const team = side === 'mine' ? app.my : app.opp;
    if (team[Number(idx)]) openSetEditor(side, Number(idx));
    else openSpeciesPicker(side, Number(idx));
  });
  $('#oppSlots').addEventListener('click', (e) => {
    const el = e.target.closest('[data-slot]');
    if (!el) return;
    const [side, idx] = el.dataset.slot.split(':');
    const team = app.opp;
    if (team[Number(idx)]) openSetEditor(side, Number(idx));
    else openSpeciesPicker(side, Number(idx));
  });

  $('#btnStart').onclick = startBattle;

  // 数据池：点芯片整套填入 / 打开数据管理
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-lib]');
    if (chip) { fillFromLib(chip.dataset.lib); return; }
    if (e.target.closest('[data-act="data"]')) openDataModal();
    if (e.target.closest('[data-act="ocr"]')) openOcrModal();
  });

  // 推荐卡 & 全部
  $('#recoBox').addEventListener('click', (e) => {
    const c = e.target.closest('[data-reco]');
    if (c) {
      app.choice = app.ranked[Number(c.dataset.reco)].action;
      render();
      return;
    }
    if (e.target.closest('#btnAllActions')) openAllActions();
  });

  // 精灵卡
  $('#oppRow').addEventListener('click', (e) => {
    const el = e.target.closest('[data-mon]');
    if (!el) return;
    const [side, idx] = el.dataset.mon.split(':');
    openMonEditor(side, Number(idx));
  });
  $('#myRow').addEventListener('click', (e) => {
    const el = e.target.closest('[data-mon]');
    if (!el) return;
    const [side, idx] = el.dataset.mon.split(':');
    openMonEditor(side, Number(idx));
  });

  $('#btnOppAction').onclick = openOppActionModal;
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) copyText(c.dataset.copy);
  });
  const endBtn = $('#btnEndGame');
  if (endBtn) endBtn.onclick = openEndGameModal;
  const addFoeBtn = $('#btnAddFoe');
  if (addFoeBtn) addFoeBtn.onclick = openAddFoeModal;
  $('#btnOppMove').onclick = openOppActionModal;
  $('#btnGuideClose').onclick = () => { app.guideOff = true; save(); render(); };
  $('#btnResolve').onclick = doResolve;
  $('#btnUndo').onclick = undo;
  $('#btnFix').onclick = () => {
    const s = app.battle;
    if (!s) return;
    openModal('修正血量 / 状态', `
      <div class="field-label">我方</div>
      <div class="list">${s.mine.map((m, i) => m ? `<button class="item" data-act="mon" data-side="mine" data-i="${i}">
        <div class="grow"><div class="t1">${esc(m.name)}</div><div class="t2">${m.hp}/${m.maxHp}${m.status ? ' · ' + STATUS_ZH[m.status] : ''}</div></div>
      </button>` : '').join('')}</div>
      <div class="field-label">对手</div>
      <div class="list">${s.theirs.map((m, i) => m ? `<button class="item" data-act="mon" data-side="theirs" data-i="${i}">
        <div class="grow"><div class="t1">${esc(m.name)}</div><div class="t2">${m.hp}/${m.maxHp}${m.status ? ' · ' + STATUS_ZH[m.status] : ''}</div></div>
      </button>` : '').join('')}</div>
    `, {
      mon: (el) => openMonEditor(el.dataset.side, Number(el.dataset.i)),
    });
  };

  document.addEventListener('paste', async (e) => {
    const tgt = e.target;
    if (tgt && tgt.matches && tgt.matches('input, textarea')) return;   // 输入框里的粘贴不动
    if (!document.querySelector('#ocrDrop')) {
      const items0 = (e.clipboardData && e.clipboardData.items) || [];
      let img0 = null;
      for (const it of items0) {
        if (it.type && it.type.indexOf('image/') === 0) { img0 = it.getAsFile && it.getAsFile(); break; }
      }
      if (!img0) return;
      e.preventDefault();
      openOcrModal();
      await handleOcrFile(img0);
      return;
    }
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf('image/') === 0) {
        const f = it.getAsFile && it.getAsFile();
        if (f) { e.preventDefault(); await handleOcrFile(f); }
        return;
      }
    }
  });

  $('#modalClose').onclick = closeModal;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#modalBody').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = modalHandlers[el.dataset.act];
    if (fn) fn(el, e);
  });

  $('#btnMenu').onclick = () => openModal('菜单', `
    <div class="list">
      <button class="item" data-act="ocr"><div class="grow"><div class="t1">识图填队</div><div class="t2">把游戏截图粘进来，自动认出精灵和招式</div></div></button>
      <button class="item" data-act="data"><div class="grow"><div class="t1">数据（精灵配招库）</div><div class="t2">导入 / 导出 / 查看已记住的配招</div></div></button>
  <button class="item" data-act="newgame"><div class="grow"><div class="t1">开始新的一场对战</div><div class="t2">保留队伍配置，重置血量</div></div></button>
      <button class="item" data-act="share"><div class="grow"><div class="t1">分享给朋友 / 手机打开</div><div class="t2">127.0.0.1 只能自己用，这里给能发出去的地址</div></div></button>
      <button class="item" data-act="guide"><div class="grow"><div class="t1">重看操作引导</div><div class="t2">对战页那三条提示</div></div></button>
      <button class="item" data-act="demo"><div class="grow"><div class="t1">载入示例对战</div><div class="t2">用一套示范队伍先看看效果</div></div></button>
      <button class="item" data-act="toSetup"><div class="grow"><div class="t1">编辑队伍</div><div class="t2">回去修改精灵、招式、道具</div></div></button>
      <button class="item" data-act="wipe"><div class="grow"><div class="t1">清空全部配置</div><div class="t2">队伍和对战记录都会删除</div></div></button>
    </div>
    <p class="hint">队伍和对战记录存在这台设备里；精灵配招库会同步到服务端，同一个网址的所有人共用。</p>
  `, {
    ocr: () => { closeModal(); openOcrModal(); },
    data: () => { closeModal(); openDataModal(); },
    share: () => { closeModal(); openShareModal(); },
    guide: () => { closeModal(); app.guideOff = false; save(); render(); },
    demo: () => { closeModal(); loadDemo(); startBattle(); },
    newgame: () => { closeModal(); startBattle(); },
    toSetup: () => { closeModal(); app.tab = 'setup'; render(); },
    wipe: () => {
      localStorage.removeItem(LS_KEY);
      app.my = [null, null, null, null];
      app.opp = [null, null, null, null];
      app.battle = null;
      app.logs = [];
      app.history = [];
      app.ranked = [];
      app.choice = null;
      app.tab = 'setup';
      closeModal();
      render();
    },
  });
}

// ------------------------------------------------------------------ demo

const DEMO_MY = [
  ['garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance'], 'lifeorb', 'roughskin'],
  ['heatran', ['flamethrower', 'earthpower', 'stealthrock', 'protect'], 'leftovers', 'flashfire'],
  ['rotomwash', ['hydropump', 'voltswitch', 'willowisp', 'thunderbolt'], 'leftovers', 'levitate'],
  ['scizor', ['bulletpunch', 'uturn', 'superpower', 'swordsdance'], 'choiceband', 'technician'],
];
const DEMO_OPP = [
  ['tyranitar', ['crunch', 'stoneedge', 'fireblast', 'pursuit'], null, null],
  ['gengar', ['shadowball', 'sludgewave', 'focusblast', 'thunderbolt'], null, null],
  ['skarmory', ['bravebird', 'roost', 'whirlwind', 'spikes'], null, null],
  ['blissey', ['softboiled', 'seismictoss', 'toxic', 'aromatherapy'], null, null],
];

function loadDemo() {
  app.demo = true;
  const mk = (rows) => rows.map(([id, moves, item, abil]) => {
    if (!app.dex.species[id]) return null;
    return {
      speciesId: id,
      moves: moves.filter((m) => app.dex.moves[m]),
      item, ability: abil, nature: 'hardy',
    };
  });
  app.my = mk(DEMO_MY).concat([null, null, null, null]).slice(0, 4);
  app.opp = mk(DEMO_OPP).concat([null, null, null, null]).slice(0, 4);
}

// ------------------------------------------------------------------ boot

async function boot() {
  const rl = $('#btnReload');
  if (rl) rl.onclick = () => location.reload();
  checkVersion();
  setInterval(checkVersion, 45000);
  app.dex = await loadDexBrowser('data/gen5', 'data');
  setDex(app.dex);
  restore();
  loadLib();
  await syncPull();
  rememberTeam();
  pushPoolToEngine();
  bindEvents();
  const params = new URLSearchParams(location.search);
  if (params.get('mini') === '1') document.body.classList.add('mini');
  if (params.get('demo') === '1') {
    loadDemo();
    startBattle();
  }
  $('#dataStat').textContent = `${Object.keys(app.dex.species).length} 只精灵 / ${Object.keys(app.dex.moves).length} 个招式`;
  $('#boot').hidden = true;
  $('#app').hidden = false;
  if (app.battle) recompute();
  render();
  // 调试 / 自动化测试用
  window.__app = app;
  window.__api = {
    app, checkVersion, startBattle, recompute, render, doResolve, undo,
    openMonEditor, openSetEditor, openOppActionModal, worstOppAction,
    openAllActions, openSpeciesPicker, openMovePicker, openItemPicker, openAbilityPicker,
    openOcrModal, handleOcrDataUrl, ocrFillAll, openDataModal, forgetLib,
    openAddFoeModal, addNewOppMon, suggestFoeMoves,
  };
}

boot().catch((err) => {
  console.error(err);
  $('#bootText').textContent = '加载失败：' + (err && err.message ? err.message : err);
  $('#bootText').style.color = '#ff5c5c';
});
