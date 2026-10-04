// 值班模板功能自测：用最小 DOM 桩在 Node 中直接运行 index.html 里的真实 JS
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function mkEl(id) {
  const el = {
    id, style: {}, dataset: {}, title: '', value: '', innerHTML: '', textContent: '',
    disabled: false, children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, click() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return null; }, cloneNode() { return mkEl(id); },
    getAttribute() { return null; }, setAttribute() {}, removeAttribute() {},
  };
  // showConfirm 会执行 okBtn.parentNode.replaceChild(...) → 需要最小 parentNode 桩
  el.parentNode = { replaceChild() {}, removeChild() {}, appendChild() {} };
  return el;
}

const els = {};
const document = {
  documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute() { return null; } },
  getElementById(id) { return els[id] || (els[id] = mkEl(id)); },
  createElement(tag) { return mkEl(tag); },
  querySelectorAll() { return []; }, querySelector() { return null; },
  addEventListener() {}, body: mkEl('body'),
};

const store = {};
const localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  clear() { for (const k in store) delete store[k]; },
  _dump() { return store; }, _set(k, v) { store[k] = v; }
};

const writeFiles = [];
class Blob { constructor(parts, opts) { this.parts = parts; this.opts = opts; } }

/**
 * 定时器桩：必须 unref()，否则 Node 会为了等定时器而拖着进程不退出。
 *
 * 页面里的 setTimeout 只有一处用途 —— showToast() 用它让提示条 3 秒后自动隐藏。
 * 若直接用真实 setTimeout，测试跑完后事件循环还要空转满 3 秒才退出：
 * test-layout 实测 3.08s 墙钟却只花 0.083s CPU，那 3 秒全是干等。
 * 测试没有任何一条依赖这个回调真的触发（只静态断言过 .toast 的 CSS），
 * 所以 unref 掉既不影响断言，又能让进程立刻退出。
 *
 * 注意 unref 后回调仍会在事件循环自然存活期间照常触发（例如测试内部的 await
 * 让出控制权时），只是它不再能独自撑住进程。
 */
const pendingTimers = [];
function stubSetTimeout(fn, ms, ...args) {
  const t = setTimeout(fn, ms, ...args);
  if (t && typeof t.unref === 'function') t.unref();
  pendingTimers.push(t);
  return t;
}
function stubSetInterval(fn, ms, ...args) {
  const t = setInterval(fn, ms, ...args);
  if (t && typeof t.unref === 'function') t.unref();
  pendingTimers.push(t);
  return t;
}
/** 退出前清干净，避免残留定时器影响 process.exitCode / 事件循环 */
function clearAllTimers() {
  for (const t of pendingTimers) {
    try { clearTimeout(t); clearInterval(t); } catch (e) {}
  }
  pendingTimers.length = 0;
}

const sandbox = {
  document, localStorage, Blob, console,
  window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  setTimeout: stubSetTimeout, clearTimeout, setInterval: stubSetInterval, clearInterval,
  Math, Date, JSON, Set, Map, Array, Object, String, Number, Boolean,
  isNaN, parseInt, parseFloat, RegExp, Error, TypeError, Promise, Symbol,
  XLSX: {
    utils: {
      book_new: () => ({ Sheets: {}, SheetNames: [] }),
      aoa_to_sheet: (rows) => ({ rows }),
      book_append_sheet: (wb, ws, name) => { wb.Sheets[name] = ws; wb.SheetNames.push(name); },
    },
    writeFile: (wb, fn) => { writeFiles.push({ wb, fn }); },
  },
};
sandbox.globalThis = sandbox;

// 直接从 index.html 抽取内联 JS，保证测试对象始终是最新代码（无需手工导出）
function readHtml() {
  return fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
}

function extractInlineJs() {
  const html = readHtml();
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (blocks.length === 0) throw new Error('index.html 中未找到内联 script');
  return blocks.reduce((a, b) => (a.length >= b.length ? a : b));
}

const js = extractInlineJs();
const ctx = vm.createContext(sandbox);
vm.runInContext(js, ctx, { filename: 'app.js' });

const el = (id) => document.getElementById(id);
const g = (expr) => vm.runInContext(expr, ctx);

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else {
    fail++; failures.push(label);
    console.log('  \x1b[31m✗\x1b[0m ' + label + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, label, a === e ? undefined : { actual, expected });
}
function section(t) { console.log('\n\x1b[1m=== ' + t + ' ===\x1b[0m'); }
function summary() {
  const line = '='.repeat(58);
  console.log('\n' + line);
  console.log(`结果：\x1b[32m${pass} 通过\x1b[0m / ${fail ? '\x1b[31m' : ''}${fail} 失败\x1b[0m`);
  // 断言全部跑完后清掉残留定时器（showToast 的自动隐藏计时器等），让进程干净退出
  clearAllTimers();
  if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exitCode = 1; }
  return fail === 0;
}

module.exports = { ctx, sandbox, document, localStorage, el, g, ok, eq, section, summary, writeFiles, failures, rawHtml: readHtml, clearAllTimers };
