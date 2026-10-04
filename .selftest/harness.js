// 值班模板功能自测：用最小 DOM 桩在 Node 中直接运行 index.html 里的真实 JS
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ── 极简 HTML 片段解析 ────────────────────────────────────────────
 * 页面代码会重写 innerHTML，再用 querySelector 去就地修改其中的元素
 * （renderStudentList / updateStudentListItem / highlightStudent）。
 * 桩若永远返回 null，这些「不整列重渲染」的代码路径就没法测 —— 以前正是如此。
 * 这里实现一层够用的解析：把 innerHTML 里的一层层标签解析成带属性、带偏移量的节点，
 * querySelector / textContent / className 的读写都落到该元素当前的 innerHTML 字符串上。
 * 只求覆盖页面真实用到的选择器（.class、[attr="v"]、tag），不做通用 DOM。
 */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);

function parseAttrs(str) {
  const attrs = {};
  for (const m of String(str || '').matchAll(/([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase();
    const val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : ''));
    attrs[name] = val;
  }
  return attrs;
}

/** 解析 html 里的顶层元素，每个节点带 start/innerStart/innerEnd/end 偏移量（可写回字符串） */
function parseFragmentUncached(html) {
  const roots = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          const node = stack.splice(i, 1)[0];
          node.innerEnd = m.index;
          node.end = re.lastIndex;
          break;
        }
      }
      continue;
    }
    const node = {
      tag, attrs: parseAttrs(m[3]),
      start: m.index, innerStart: re.lastIndex,
      innerEnd: html.length, end: html.length,
      children: [], parent: stack.length ? stack[stack.length - 1] : null,
    };
    node.classes = String(node.attrs.class || '').split(/\s+/).filter(Boolean);
    if (node.parent) node.parent.children.push(node); else roots.push(node);
    if (m[4] === '/' || VOID_TAGS.has(tag)) {
      node.innerEnd = node.end = re.lastIndex;   // 自闭合 / 空元素：内部为空
    } else {
      stack.push(node);
    }
  }
  return roots;
}

/**
 * 解析结果按 innerHTML 字符串缓存。
 *
 * 页面代码里 querySelector / querySelectorAll / 属性读写极其频繁（每次访问都要重新定位），
 * 而列表与表格的 innerHTML 常在一次断言里被反复查询却完全没变。
 * 不做缓存时解析会吃掉整套自测约 45% 的 CPU（实测 CPU profile），
 * 把 §5.1 守着的「约 1 秒跑完」拖慢到 2.3 秒。
 * 因此按 html 字符串记忆化：字符串一变就是新键，不会读到过期结果。
 */
const fragmentCache = new Map();
const FRAGMENT_CACHE_MAX = 400;
function parseFragment(html) {
  let hit = fragmentCache.get(html);
  if (hit) return hit;
  hit = parseFragmentUncached(html);
  // 简单封顶，避免长时间运行把整份 innerHTML 都留在内存里
  if (fragmentCache.size >= FRAGMENT_CACHE_MAX) fragmentCache.clear();
  fragmentCache.set(html, hit);
  return hit;
}

/** 选择器解析同样很热（每次 nodeMatches 都会调），一并按字符串缓存 */
const selectorCache = new Map();
function selectorParts(sel) {
  const key = String(sel);
  let hit = selectorCache.get(key);
  if (hit) return hit;
  const tag = /^([a-zA-Z][\w-]*)/.exec(key.trim());
  hit = {
    tag: tag ? tag[1].toLowerCase() : null,
    classes: [...key.matchAll(/\.([\w-]+)/g)].map(x => x[1]),
    attrs: [...key.matchAll(/\[([\w-]+)\s*=\s*"([^"]*)"\]/g)].map(x => [x[1].toLowerCase(), x[2]]),
  };
  selectorCache.set(key, hit);
  return hit;
}

function nodeMatches(node, sel) {
  const p = selectorParts(sel);
  if (p.tag && node.tag !== p.tag) return false;
  if (!p.classes.every(c => node.classes.includes(c))) return false;
  if (!p.attrs.every(([k, v]) => node.attrs[k] === v)) return false;
  return true;
}

/** 在 root 元素的当前 innerHTML 里按路径定位节点；每次访问都重新解析，偏移量始终有效 */
function resolvePath(root, path) {
  let nodes = parseFragment(root._html);
  let node = null;
  for (const i of path) {
    node = nodes[i];
    if (!node) return null;
    nodes = node.children;
  }
  if (path.length === 0) {
    // 空路径 = root 元素自身：合成一个「外壳」节点，其子节点就是顶层元素
    return { tag: '#root', attrs: {}, classes: [], children: nodes, parent: null,
             start: 0, innerStart: 0, innerEnd: root._html.length, end: root._html.length };
  }
  return node;
}

function findPath(root, basePath, sel) {
  const base = resolvePath(root, basePath);
  if (!base) return null;
  const walk = (nodes, prefix) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], p = prefix.concat([i]);
      if (nodeMatches(n, sel)) return p;
      const deeper = walk(n.children, p);
      if (deeper) return deeper;
    }
    return null;
  };
  const rel = walk(base.children, []);
  return rel ? basePath.concat(rel) : null;
}

function collectPaths(root, basePath, sel, out = []) {
  const base = resolvePath(root, basePath);
  if (!base) return out;
  const walk = (nodes, prefix) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], p = prefix.concat([i]);
      if (nodeMatches(n, sel)) out.push(p);
      walk(n.children, p);
    }
  };
  walk(base.children, basePath);
  return out;
}

/** 已解析节点的桩：读写都会落到所属元素的 innerHTML 字符串上 */
function mkNodeStub(root, path) {
  const stub = {
    _root: root, _path: path,
    get _node() { return resolvePath(root, path); },
    get tagName() { const n = stub._node; return n ? n.tag.toUpperCase() : ''; },
    get className() { const n = stub._node; return n ? (n.attrs.class || '') : ''; },
    set className(v) { stub.setAttribute('class', v); },
    get textContent() {
      const n = stub._node;
      if (!n) return '';
      return root._html.slice(n.innerStart, n.innerEnd).replace(/<[^>]*>/g, '');
    },
    set textContent(v) {
      const n = stub._node;
      if (!n) return;
      root._html = root._html.slice(0, n.innerStart) + String(v) + root._html.slice(n.innerEnd);
    },
    get dataset() {
      const n = stub._node, d = {};
      if (!n) return d;
      for (const k in n.attrs) {
        if (k.startsWith('data-')) d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = n.attrs[k];
      }
      return d;
    },
    getAttribute(name) {
      const n = stub._node;
      const key = String(name).toLowerCase();
      return n && n.attrs[key] !== undefined ? n.attrs[key] : null;
    },
    setAttribute(name, value) {
      const n = stub._node;
      if (!n) return;
      const html = root._html;
      let open = html.slice(n.start, n.innerStart);
      const re = new RegExp('(\\s' + name + '\\s*=\\s*)("[^"]*"|\'[^\']*\'|[^\\s>]+)', 'i');
      if (re.test(open)) open = open.replace(re, `$1"${value}"`);
      else open = open.replace(/(\s*\/?>)$/, ` ${name}="${value}"$1`);
      root._html = html.slice(0, n.start) + open + html.slice(n.innerStart);
    },
    removeAttribute(name) {
      const n = stub._node;
      if (!n) return;
      const html = root._html;
      let open = html.slice(n.start, n.innerStart);
      const re = new RegExp('\\s' + name + '\\s*=\\s*("[^"]*"|\'[^\']*\'|[^\\s>]+)', 'i');
      open = open.replace(re, '');
      root._html = html.slice(0, n.start) + open + html.slice(n.innerStart);
    },
    querySelector(sel) {
      const p = findPath(root, path, sel);
      return p ? mkNodeStub(root, p) : null;
    },
    querySelectorAll(sel) {
      return collectPaths(root, path, sel).map(p => mkNodeStub(root, p));
    },
    closest() { return null; },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, click() {},
  };
  stub.classList = {
    _list() { return stub.className.split(/\s+/).filter(Boolean); },
    _write(list) { stub.className = list.join(' '); },
    add(c) { const l = stub.classList._list(); if (!l.includes(c)) { l.push(c); stub.classList._write(l); } },
    remove(c) { stub.classList._write(stub.classList._list().filter(x => x !== c)); },
    contains(c) { return stub.classList._list().includes(c); },
    toggle(c, f) {
      const on = f === undefined ? !stub.classList.contains(c) : !!f;
      if (on) stub.classList.add(c); else stub.classList.remove(c);
    },
  };
  // showConfirm 会执行 okBtn.parentNode.replaceChild(...) → 需要最小 parentNode 桩
  stub.parentNode = { replaceChild() {}, removeChild() {}, appendChild() {} };
  return stub;
}

function mkEl(id) {
  const el = {
    id, style: {}, dataset: {}, title: '', value: '', _html: '', _text: undefined,
    disabled: false, children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, click() {},
    querySelector(sel) { const p = findPath(el, [], sel); return p ? mkNodeStub(el, p) : null; },
    querySelectorAll(sel) { return collectPaths(el, [], sel).map(p => mkNodeStub(el, p)); },
    closest() { return null; }, cloneNode() { return mkEl(id); },
    getAttribute() { return null; }, setAttribute() {}, removeAttribute() {},
  };
  // innerHTML 用访问器：setter 只存字符串，querySelector 时按需解析
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); },
    enumerable: true, configurable: true,
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._text !== undefined ? el._text : el._html.replace(/<[^>]*>/g, ''); },
    set(v) { el._text = String(v); },
    enumerable: true, configurable: true,
  });
  // showConfirm 会执行 okBtn.parentNode.replaceChild(...) → 需要最小 parentNode 桩
  el.parentNode = { replaceChild() {}, removeChild() {}, appendChild() {} };
  return el;
}

const els = {};
const document = {
  documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute() { return null; } },
  getElementById(id) { return els[id] || (els[id] = mkEl(id)); },
  createElement(tag) { return mkEl(tag); },
  querySelectorAll(sel) {
    const out = [];
    for (const key in els) out.push(...els[key].querySelectorAll(sel));
    return out;
  },
  querySelector(sel) {
    for (const key in els) {
      const hit = els[key].querySelector(sel);
      if (hit) return hit;
    }
    return null;
  },
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
