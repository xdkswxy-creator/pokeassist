// 无头逻辑测试：用一个极简 DOM 桩把 app.js 跑起来，
// 检查渲染、推荐、结算、撤销这些流程不报错，并且输出合理。
import assert from 'node:assert';

const BASE = 'http://127.0.0.1:8765/';
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  const url = String(u).startsWith('http') ? String(u) : BASE + String(u).replace(/^\//, '');
  const method = (o && o.method) || 'GET';
  // 测试不许写服务端（会把示例队伍灌进用户的共享库）
  if (/\/api\/(state|forget)/.test(url) && method !== 'GET') {
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, added: 0, count: 0 }) });
  }
  return realFetch(url, o);
};

// ------------------------------------------------------------ 极简 DOM 桩
class El {
  constructor(sel) {
    this.sel = sel;
    this._html = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '0';
    this.style = { cssText: '', color: '' };
    this.dataset = {};
    this.children = [];
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
    this.parentElement = null;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  get scrollTop() { return 0; }
  set scrollTop(v) {}
  addEventListener() {}
  remove() {}
  closest() { return null; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  appendChild(c) { this.children.push(c); return c; }
  focus() {}
}

const registry = new Map();
const el = (sel) => {
  if (!registry.has(sel)) registry.set(sel, new El(sel));
  return registry.get(sel);
};

globalThis.document = {
  querySelector: el,
  querySelectorAll: (sel) => (sel === '.tab' ? [el('.tab1'), el('.tab2'), el('.tab3')] : []),
  createElement: () => new El('created'),
  addEventListener() {},
  body: el('body'),
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
globalThis.location = { search: '' };

// ------------------------------------------------------------ 跑起来
const mod = await import('../web/js/app.js');
// boot() 在模块顶层被调用，等它完成
for (let i = 0; i < 200 && !globalThis.__api; i++) await new Promise((r) => setTimeout(r, 50));
assert.ok(globalThis.__api, 'boot() 没有完成');
const { app, startBattle, doResolve, undo, recompute } = globalThis.__api;

const dex = app.dex;
assert.ok(Object.keys(dex.species).length > 600, 'species 数据量异常');
console.log('✓ 数据加载 species=%d moves=%d abilities=%d',
  Object.keys(dex.species).length, Object.keys(dex.moves).length, Object.keys(dex.abilities).length);

const setOf = (id, moves, item, ability) => ({
  speciesId: id, moves, item: item || null, ability: ability || null, nature: 'adamant',
});

app.my = [
  setOf('garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance'], 'lifeorb', 'roughskin'),
  setOf('heatran', ['flamethrower', 'earthpower', 'stealthrock', 'protect'], 'leftovers', 'flashfire'),
  setOf('rotomwash', ['hydropump', 'voltswitch', 'willowisp', 'thunderbolt'], 'leftovers', 'levitate'),
  setOf('scizor', ['bulletpunch', 'uturn', 'superpower', 'swordsdance'], 'choiceband', 'technician'),
];
app.opp = [
  setOf('tyranitar', ['crunch', 'stoneedge', 'fireblast', 'pursuit']),
  setOf('gengar', ['shadowball', 'sludgewave', 'focusblast', 'thunderbolt']),
  setOf('skarmory', ['bravebird', 'roost', 'whirlwind', 'spikes']),
  setOf('blissey', ['softboiled', 'seismictoss', 'toxic', 'aromatherapy']),
];
app.tab = 'battle';
startBattle();

assert.ok(app.battle, '没有建立对战状态');
console.log('✓ 开战 onField=%j bench=%j', app.battle.onField, app.battle.bench);
assert.strictEqual(app.battle.onField.mine.length, 3);
assert.strictEqual(app.battle.bench.mine, 3);

assert.ok(app.ranked.length > 0, '没有推荐结果');
console.log('✓ 推荐 %d 个，前三：', app.ranked.length);
for (const r of app.ranked.slice(0, 3)) {
  const a = r.action;
  console.log('   %s%%  %s · %s', (r.score * 100).toFixed(1),
    app.battle.mine[a.mon].name, a.moveId || '(换人)');
}
assert.ok(app.ranked[0].score >= app.ranked[1].score, '排序不对');

const box = el('#recoBox').innerHTML;
assert.ok(box.includes('推荐'), '推荐区没渲染');
assert.ok(box.includes('胜率'), '推荐卡没渲染');
assert.ok(el('#myRow').innerHTML.includes('烈咬陆鲨') || el('#myRow').innerHTML.length > 50, '我方场地区域为空');
assert.ok(el('#oppRow').innerHTML.length > 50, '对手场地区域为空');

// 连续结算 3 回合，确认不会崩
for (let i = 1; i <= 3; i++) {
  const before = app.turnNo;
  doResolve();
  assert.strictEqual(app.turnNo, before + 1, `第 ${i} 回合没推进`);
  assert.ok(app.battle.mine.length === 4, '队伍长度被破坏');
  const alive = app.battle.mine.filter((m) => !m.fainted && m.hp > 0).length;
  console.log('✓ 第 %d 回合结算完成 我方存活 %d 对方存活 %d 胜率估计 %s%%',
    i, alive, app.battle.theirs.filter((m) => !m.fainted && m.hp > 0).length,
    (app.ranked[0] ? app.ranked[0].score * 100 : 0).toFixed(1));
}

// 撤销
const t = app.turnNo;
undo();
assert.strictEqual(app.turnNo, t - 1, '撤销没有回退回合');
console.log('✓ 撤销正常');

// 中文名
assert.ok(app.battle.mine[0].name && !/^[a-z]/.test(app.battle.mine[0].name), '精灵名没有中文化: ' + app.battle.mine[0].name);
console.log('✓ 中文名：「%s」', app.battle.mine[0].name);
console.log('✓ 招式名：「%s」', el('#recoBox').innerHTML.match(/<b>([^<]+)<\/b>/)[1]);

// 把各个弹窗都渲染一遍，确保没有运行时错误
const api = globalThis.__api;
const modalChecks = [
  ['对手出招弹窗', () => api.openOppActionModal()],
  ['全部出招弹窗', () => api.openAllActions()],
  ['我方精灵修正', () => api.openMonEditor('mine', 0)],
  ['对手精灵修正', () => api.openMonEditor('theirs', 1)],
  ['队伍编辑', () => api.openSetEditor('mine', 0)],
  ['精灵选择', () => api.openSpeciesPicker('mine', 3)],
  ['招式选择', () => api.openMovePicker('mine', 0, 1)],
  ['道具选择', () => api.openItemPicker('mine', 0)],
  ['特性选择', () => api.openAbilityPicker('mine', 0)],
];
for (const [name, fn] of modalChecks) {
  el('#modalBody').innerHTML = '';
  fn();
  const html = el('#modalBody').innerHTML;
  assert.ok(html.length > 30, name + ' 没有渲染出内容');
  console.log('✓ %s (%d 字)', name, html.length);
}

console.log('\n全部通过 ✅');
process.exit(0);   // app.js 里有 setInterval，不主动退出会一直挂着
