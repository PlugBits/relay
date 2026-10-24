#!/usr/bin/env node
// kintone の画面を手元の headless Chromium で開いて console.error・未捕捉例外・
// kintone.events の発火順を集める CLI。
//
// 使い方:
//   node tools/kin-probe.mjs <appId> [--plugin <pluginId>] [--record <recordId>]
//                             [--pages config,detail,index] [--screenshot <dir>] [--sheet <out.png>] [--wait <ms>]
//                             [--actions <file.json>]
//   --sheet: 開いた画面を縮小1枚の PNG にまとめる(1回に1枚・最大2コマ・1コマ540px幅=横1080px以下)。
//            通常は plugin があれば 設定|詳細、無ければ 詳細|一覧。--actions の時は 直前|最後の画面。
//            出力 JSON に sheet: <絶対パス> と sheetPages。作れない時は sheet:null, sheetError
//            (プローブ自体は ok のまま)。--sheet を渡したら、skipped・ログイン失敗・手順の失敗・
//            例外のどの終わり方でも sheet(か null+sheetError)が必ず出る。
//   --actions: 手順の配列(最大30)を JSON ファイルで渡し、1枚のページで順に流す(--pages は無視)。
//            { "open": "detail|index|config|create|edit", "record": "42" }   record 無しの detail/edit は最新レコード
//            { "click": "text=保存" } か { "click": { "role": "button", "name": "保存" } }   CSS セレクタは bad_input
//            { "fill": { "label": "品番", "value": "ZZ-999" } } / { "select": { "label": "統合先", "value": "RM-401" } }
//                 ラベルから欄を探す: getByLabel → getByRole(textbox/combobox) → ラベル文字の後ろの最初の入力欄(xpath following::)
//            { "press": "Enter" } / { "save": true }(「保存」ボタン→遷移待ち) / { "expect": { "text": "未登録", "exact": true } }(見えるまで・既定5秒。exact で文字全体の一致だけ)
//            { "wait": 500 }(最大10000ms) / { "read": true }(今の画面の文字)
//            失敗した手順で止め、残りは skipped。本番(env.mode=prod)で fill/select/press/save/click を含むと
//            ブラウザを起こさず {ok:false, error:{code:'prod_denied'}}。open/expect/wait/read は本番でも可。
//   出力に actions[{i,kind,ok,ms,url,recordId?,error?,text?}]・opened{page,recordId,url}・screen{dialog?,text,buttons,labels}、
//   各ページに loads(document の読み込み回数)と events[{type,count,handlers}](handlers=kintone.events.on の登録数)。
//   --actions 無しでも detail の結果に recordId、config の結果に screen が入る。
//
// 接続情報は tools/kin-env.mjs の loadKinEnv() で読む(~/.config/tiny-pulse/kintone.env)。
//
// chromium の解決(この mod 自身はブラウザを入れない):
//   1. 環境変数 RELAY_CHROMIUM があればその実行ファイルを使う
//   2. 無ければ playwright の既定のビルドを使う
//   RELAY_NATIVE_LIBS があれば LD_LIBRARY_PATH の先頭に足す(それ以外はしない)。
// システムの共有ライブラリ(libnspr4.so など)が足りない常駐機の例(パスは各自の環境に読み替え):
//   export RELAY_CHROMIUM=<playwright のキャッシュ>/chromium-<build>/chrome-linux64/chrome
//   export RELAY_NATIVE_LIBS=<libnspr4.so などを置いたディレクトリ>
// chromium が起動できない・ログインできない時は画面チェックだけ省略(ok:true, skipped:true)して返す。
// 反映(deploy)は止めない。chromium の入れ方は /kin doctor が案内する。

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKinEnv, authHeaders, KinEnvError } from './kin-env.mjs';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'usage';
  }
}

class BadInputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_input';
  }
}

class LoginError extends Error {
  constructor(message) {
    super(message);
    this.code = 'login';
  }
}

const PAGE_LABEL = { config: '設定', detail: '詳細', index: '一覧' };

// 除外リスト: 読み込み失敗(404 など)のうち、URL のパスがここに合うものは
// consoleErrors / failedRequests から外して ignored: [{path, reason}] に移す。
// Claude に渡す本当のエラーだけを残すため。広く取らない(プラグインの /k/api/js/ や
// plugin のファイルはここに入れない)。パスはクエリ無し。
export const IGNORE_LOAD_FAILURES = [
  // 実機で /k/m/ 一覧に出た 404(2026-10)。プラグインのファイルではない
  { re: /^\/favicon\.ico$/, reason: 'ブラウザが自動で取りに行く favicon(kintone 側・プラグインと無関係)' },
];

export function ignoreReason(urlPath, list = IGNORE_LOAD_FAILURES) {
  const hit = list.find((x) => x.re.test(urlPath));
  return hit ? hit.reason : null;
}

function pathOnly(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}

// ---- chromium / 共有ライブラリの解決 -------------------------------------

export function findExecutable(env = process.env) {
  return env.RELAY_CHROMIUM || undefined; // 未指定なら playwright 既定に任せる
}

// RELAY_NATIVE_LIBS がある時だけ LD_LIBRARY_PATH の先頭に足す
export function applyNativeLibs(env = process.env) {
  const dir = env.RELAY_NATIVE_LIBS;
  if (!dir) return;
  env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${dir}:${env.LD_LIBRARY_PATH}` : dir;
}

// ---- CLI 引数 --------------------------------------------------------------

function parseArgs(argv) {
  const args = { appId: null, plugin: null, record: null, pages: null, screenshot: null, sheet: null, thumbs: null, actions: null, wait: 3000 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plugin') args.plugin = argv[++i];
    else if (a === '--record') args.record = argv[++i];
    else if (a === '--pages') args.pages = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--screenshot') args.screenshot = argv[++i];
    else if (a === '--sheet') args.sheet = argv[++i];
    else if (a === '--thumbs') args.thumbs = argv[++i];
    else if (a === '--actions') args.actions = argv[++i];
    else if (a === '--wait') args.wait = Number.parseInt(argv[++i], 10);
    else positional.push(a);
  }
  args.appId = positional[0] || null;
  if (!Number.isFinite(args.wait) || args.wait < 0) args.wait = 3000;
  return args;
}

function resolvePageNames(args) {
  const requested = args.pages || (args.plugin ? ['config', 'detail', 'index'] : ['detail', 'index']);
  // --plugin が無ければ config は常に開かない(明示的に --pages に入れても無視する)
  return requested.filter((p) => p !== 'config' || !!args.plugin);
}

// ---- ブラウザ内に注入する初期化スクリプト ----------------------------------
// addInitScript に渡す関数は外側のスコープを閉じない(toString() されて
// ページ内で評価される)。window.kintone が後から代入される前提で setter を
// 仕掛け、kintone.events.on(...) の handler を発火順の記録用に包む。
function kinProbeInitScript() {
  if (window.__kinProbe) return;
  window.__kinProbe = { id: Math.random().toString(36).slice(2), events: [], handlers: {} };

  function wrapEvents(events) {
    if (!events || events.__kinProbeWrapped || typeof events.on !== 'function') return events;
    const origOn = events.on.bind(events);
    events.on = function (types, handler) {
      const typeList = Array.isArray(types) ? types : [types];
      // 登録の重複(同じ type に何回 on されたか)を数える
      for (const t of typeList) window.__kinProbe.handlers[t] = (window.__kinProbe.handlers[t] || 0) + 1;
      const wrapped = function (...args) {
        const ev = args[0];
        const t = (ev && ev.type) || typeList[0];
        window.__kinProbe.events.push({ type: t, t: Date.now() });
        // 元の挙動は変えない: 同期 throw はそのまま再 throw、
        // Promise を返す場合もそのまま返す(reject も素通し)。
        return handler.apply(this, args);
      };
      return origOn(types, wrapped);
    };
    events.__kinProbeWrapped = true;
    return events;
  }

  let current = window.kintone;
  if (current && current.events) wrapEvents(current.events);
  try {
    Object.defineProperty(window, 'kintone', {
      configurable: true,
      enumerable: true,
      get() {
        // kintone は代入の後で events を生やすので、読まれた時にも包む
        if (current && current.events) wrapEvents(current.events);
        return current;
      },
      set(v) {
        current = v;
        if (v && v.events) wrapEvents(v.events);
      },
    });
  } catch {
    // 既に non-configurable なら諦める(その時点の値だけラップ済み)
  }
}

// ---- 画面1枚分のプローブ ----------------------------------------------------

function extractFileLine(s) {
  if (!s) return '';
  const m = String(s).match(/([^/\\?#\s()]+\.(?:js|css)):(\d+)/);
  return m ? `${m[1]}:${m[2]}` : '';
}

// ページに付ける収集器: console.error・未捕捉例外・失敗した読み込み・document の読み込み回数・events。
// ページが遷移すると window.__kinProbe は作り直されるので、document ごと(id)に控えを取って足し合わせる。
function createCollector(page, baseHost) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const ignored = [];
  const docs = new Map(); // id → { order:[type…], handlers:{type:n} }
  let loads = 0;

  page.on('load', () => {
    loads += 1;
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location();
    const line = (loc && typeof loc.lineNumber === 'number') ? loc.lineNumber + 1 : undefined;
    const entry = { text: msg.text(), location: loc && loc.url ? `${loc.url}:${line}` : '' };
    // 「Failed to load resource」は location が読めなかった URL そのもの。出どころ用にパス(クエリ無し)を添える
    if (/^Failed to load resource/.test(entry.text) && loc && loc.url) {
      const p = pathOnly(loc.url);
      if (p) {
        const reason = ignoreReason(p);
        if (reason) {
          ignored.push({ path: p, reason });
          return;
        }
        entry.resourcePath = p;
      }
    }
    consoleErrors.push(entry);
  });

  page.on('pageerror', (err) => {
    const stack = String((err && err.stack) || (err && err.message) || err || '');
    const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);
    const message = lines[0] || (err && err.message) || String(err);
    const at = lines.find((l, i) => i > 0 && /^at\b/.test(l)) || lines[1] || '';
    pageErrors.push({ message, at });
  });

  page.on('response', (response) => {
    try {
      const status = response.status();
      if (status < 400) return;
      const req = response.request();
      const type = req.resourceType();
      if (type !== 'script' && type !== 'stylesheet') return;
      const u = new URL(response.url());
      if (u.hostname !== baseHost) return;
      const p = u.pathname;
      const reason = ignoreReason(p);
      if (reason) {
        ignored.push({ path: p, reason });
        return;
      }
      failedRequests.push({ url: response.url(), status });
    } catch {
      // レスポンス解析中の例外は無視(プローブ自体は止めない)
    }
  });

  return {
    consoleErrors,
    pageErrors,
    failedRequests,
    ignored,
    get loads() {
      return loads;
    },
    // 今の document の events/handlers を控える(遷移の前後で呼ぶ)
    async snapshot() {
      try {
        const s = await page.evaluate(() => (window.__kinProbe ? { id: window.__kinProbe.id, events: window.__kinProbe.events.map((e) => e.type), handlers: window.__kinProbe.handlers } : null));
        if (s && s.id) docs.set(s.id, { order: s.events, handlers: s.handlers });
      } catch {
        // 遷移の最中などで読めなければ前回の控えのまま
      }
    },
    // [{type,count,handlers}] と発火順
    aggregate() {
      const counts = new Map();
      const handlers = new Map();
      const eventOrder = [];
      for (const d of docs.values()) {
        for (const t of d.order) {
          counts.set(t, (counts.get(t) || 0) + 1);
          eventOrder.push(t);
        }
        for (const [t, n] of Object.entries(d.handlers || {})) handlers.set(t, Math.max(handlers.get(t) || 0, n));
      }
      const types = [...counts.keys(), ...[...handlers.keys()].filter((t) => !counts.has(t))];
      const events = types.map((type) => ({ type, count: counts.get(type) || 0, handlers: handlers.get(type) || 0 }));
      return { events, eventOrder };
    },
  };
}

// ---- 画面の読み取り(kintone のクラス名・id は使わない。role・タグ・見える文字だけ) -----
function readScreenInPage() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const body = (el) => String((el && el.innerText) || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].filter(vis);
  const dialog = dialogs.length ? body(dialogs[dialogs.length - 1]).slice(0, 1500) : '';
  const main = document.querySelector('main,[role="main"]') || document.body;
  const text = body(main).slice(0, 1500);
  const buttons = [];
  for (const el of document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')) {
    if (!vis(el)) continue;
    const name = clean(el.getAttribute('aria-label') || el.innerText || el.value || el.title);
    if (name && name.length <= 60 && !buttons.includes(name)) buttons.push(name);
    if (buttons.length >= 40) break;
  }
  const labels = [];
  const addLabel = (t) => {
    t = clean(t);
    if (t && t.length <= 60 && !labels.includes(t) && labels.length < 60) labels.push(t);
  };
  for (const el of document.querySelectorAll('label,legend,th')) if (vis(el)) addLabel(el.innerText);
  // ラベル要素が無い入力欄は、手前の兄弟(祖先を3つまで遡る)の短い文字か aria-label / placeholder を項目名とみなす
  for (const el of document.querySelectorAll('input,select,textarea')) {
    if (!vis(el) || el.type === 'hidden') continue;
    if (el.labels && el.labels.length) continue;
    let name = el.getAttribute('aria-label') || '';
    let cur = el;
    for (let d = 0; !name && d < 3 && cur; d++, cur = cur.parentElement) {
      let sib = cur.previousElementSibling;
      while (sib && !name) {
        const t = clean(sib.innerText);
        if (t && t.length <= 40 && vis(sib)) name = t;
        sib = sib.previousElementSibling;
      }
    }
    addLabel(name || el.getAttribute('placeholder'));
  }
  const out = { text, buttons, labels };
  if (dialog) out.dialog = dialog;
  return out;
}

async function readScreen(page) {
  try {
    return await page.evaluate(readScreenInPage);
  } catch {
    return { text: '', buttons: [], labels: [] };
  }
}

// ステップの後の「ダイアログ本文 or 見出し」(600字まで)
async function stepText(page) {
  const s = await readScreen(page);
  let t = s.dialog || '';
  if (!t) {
    try {
      t = await page.evaluate(() => {
        const h = [...document.querySelectorAll('h1,h2,[role="heading"]')].find((e) => e.getBoundingClientRect().width > 0 && (e.innerText || '').trim());
        return h ? h.innerText.trim() : '';
      });
    } catch {
      t = '';
    }
  }
  return String(t || s.text || '').slice(0, 600);
}

function recordIdFromUrl(u) {
  const m = String(u || '').match(/[#&?]record=(\d+)/);
  return m ? m[1] : null;
}

// ---- 画面1枚分のプローブ ----------------------------------------------------

async function probePage(context, name, url, { wait, screenshotDir, shots, recordId }) {
  const page = await context.newPage();
  const baseHost = new URL(url).hostname;
  const col = createCollector(page, baseHost);

  await page.addInitScript(kinProbeInitScript);

  const start = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  const ms = Date.now() - start;

  await col.snapshot();
  const { events, eventOrder } = col.aggregate();

  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, `${name}.png`) });
  }

  if (shots) shots.set(name, await page.screenshot());

  const result = {
    name, url, ms,
    consoleErrors: col.consoleErrors, pageErrors: col.pageErrors, failedRequests: col.failedRequests, ignored: col.ignored,
    events, eventOrder, loads: col.loads,
  };
  if (name === 'detail' && recordId) result.recordId = String(recordId);
  if (name === 'config') {
    const s = await readScreen(page);
    result.screen = { buttons: s.buttons, labels: s.labels, text: s.text };
    if (s.dialog) result.screen.dialog = s.dialog;
  }

  await page.close();
  return result;
}

function skippedPage(name) {
  return { name, url: null, skipped: true, ms: 0, loads: 0, consoleErrors: [], pageErrors: [], failedRequests: [], ignored: [], events: [], eventOrder: [] };
}

// ---- --actions: 手順の検証と実行 ---------------------------------------------

const MAX_STEPS = 30;
const STEP_KINDS = ['open', 'click', 'fill', 'select', 'press', 'save', 'expect', 'wait', 'read'];
const WRITE_KINDS = ['click', 'fill', 'select', 'press', 'save'];
const OPEN_TARGETS = ['detail', 'index', 'config', 'create', 'edit'];

function isObj(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

// 手順ファイルを読んで検証する。ブラウザを起こす前に呼ぶ(不正は BadInputError)
export function loadActions(file, { plugin } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new BadInputError(`--actions のファイルを読めません: ${String((e && e.message) || e).split('\n')[0].slice(0, 120)}`);
  }
  return validateActions(raw, { plugin });
}

export function validateActions(raw, { plugin } = {}) {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadInputError('--actions は手順の配列(1個以上)にしてください');
  if (raw.length > MAX_STEPS) throw new BadInputError(`手順は最大 ${MAX_STEPS} です(${raw.length} 個)`);
  return raw.map((st, idx) => {
    const at = `手順 ${idx + 1}`;
    if (!isObj(st)) throw new BadInputError(`${at}: オブジェクトにしてください`);
    const kinds = STEP_KINDS.filter((k) => k in st);
    if (kinds.length !== 1) throw new BadInputError(`${at}: ${STEP_KINDS.join('/')} のどれか1つだけを指定してください`);
    const kind = kinds[0];
    const v = st[kind];
    if (kind === 'open') {
      if (!OPEN_TARGETS.includes(v)) throw new BadInputError(`${at}: open は ${OPEN_TARGETS.join('/')} のどれかです`);
      if (v === 'config' && !plugin) throw new BadInputError(`${at}: open config には --plugin が要ります`);
      if (st.record !== undefined && !/^\d+$/.test(String(st.record))) throw new BadInputError(`${at}: record は数字のレコード番号です`);
    } else if (kind === 'click') {
      if (typeof v === 'string') {
        if (!/^text=\S/.test(v)) throw new BadInputError(`${at}: click は 'text=…' か {role,name} だけです(CSS セレクタは使えません)`);
      } else if (isObj(v)) {
        if (typeof v.role !== 'string' || !/^[a-z]+$/.test(v.role) || typeof v.name !== 'string' || !v.name) {
          throw new BadInputError(`${at}: click は {role:'button', name:'…'} の形にしてください`);
        }
      } else {
        throw new BadInputError(`${at}: click は 'text=…' か {role,name} だけです`);
      }
    } else if (kind === 'select' && isObj(v) && v.label === undefined) {
      // ラベルの無い選択欄は、選択肢の文字で指す({select:{value:'RM-401'}})
      if (!['string', 'number'].includes(typeof v.value) || !String(v.value).trim()) throw new BadInputError(`${at}: select は {label?:'項目名', value:'値'} の形にしてください`);
    } else if (kind === 'fill' || kind === 'select') {
      if (!isObj(v) || typeof v.label !== 'string' || !v.label.trim() || !['string', 'number'].includes(typeof v.value)) {
        throw new BadInputError(`${at}: ${kind} は {label:'項目名', value:'値'} の形にしてください`);
      }
    } else if (kind === 'press') {
      if (typeof v !== 'string' || !v || v.length > 40) throw new BadInputError(`${at}: press はキー名の文字列です(例 'Enter')`);
    } else if (kind === 'save' || kind === 'read') {
      if (v !== true) throw new BadInputError(`${at}: ${kind} は true を渡してください`);
    } else if (kind === 'expect') {
      if (!isObj(v) || typeof v.text !== 'string' || !v.text) throw new BadInputError(`${at}: expect は {text:'…'} の形にしてください`);
      if (v.timeout !== undefined && !(Number.isFinite(v.timeout) && v.timeout >= 0 && v.timeout <= 10000)) throw new BadInputError(`${at}: expect.timeout は 0〜10000 です`);
      if (v.exact !== undefined && typeof v.exact !== 'boolean') throw new BadInputError(`${at}: expect.exact は true / false です`);
    } else if (kind === 'wait') {
      if (!(Number.isFinite(v) && v >= 0 && v <= 10000)) throw new BadInputError(`${at}: wait は 0〜10000(ms)です`);
    }
    return { kind, ...st };
  });
}

function hasWriteStep(steps) {
  return steps.some((s) => WRITE_KINDS.includes(s.kind));
}

function xpathLiteral(s) {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `concat(${s.split('"').map((p) => `"${p}"`).join(', \'"\', ')})`;
}

// 見えている候補を DOM の後ろから試し押しし、押せる(上に覆いが無い)最初の1つを押す。
// モーダルの後ろに同じ文字(一覧の欄など)があっても、モーダル側を押すため。
async function clickable(all, timeout) {
  const until = Date.now() + timeout;
  for (;;) {
    const n = await all.count();
    for (let i = n - 1; i >= 0; i--) {
      const one = all.nth(i);
      try {
        await one.click({ trial: true, timeout: 400 });
        await one.click({ timeout: 2000 });
        return;
      } catch {
        // 覆われている・動いている → 次の候補
      }
    }
    if (Date.now() >= until) throw new Error(n ? `押せる位置にありません(候補 ${n} 個・${timeout}ms)` : `画面にありません(${timeout}ms)`);
    await all.first().page().waitForTimeout(250);
  }
}

// 選択肢の文字を持つ <select>(標準の選択欄)を後ろから探す。文字は完全一致 → 部分一致
async function selectHolding(page, value, timeout = 3000) {
  const until = Date.now() + timeout;
  for (;;) {
    for (const exact of [true, false]) {
      const sel = page.getByRole('combobox').filter({ visible: true }).filter({ has: page.getByRole('option', { name: value, exact }) });
      const n = await sel.count().catch(() => 0);
      for (let i = n - 1; i >= 0; i--) {
        // 覆い(モーダル)の下の欄は飛ばす: 欄の真ん中にある要素がその欄の中か
        const top = await sel.nth(i).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!at && (at === el || el.contains(at));
        }).catch(() => false);
        if (top) return sel.nth(i);
      }
    }
    if (Date.now() >= until) return null;
    await page.waitForTimeout(250);
  }
}

// ラベルの文字から入力欄を探す。順に: getByLabel → getByRole → ラベル文字の要素の後ろの最初の入力欄(xpath following::)。
// 画面の描画待ちのため 5 秒まで繰り返す。見つけたら見えている最初の1つを返す。
async function findField(page, rawLabel, timeout = 5000) {
  // 必須の印(末尾の * ・＊)と空白は外して探す(画面の項目名は「品番*」と読めるが、欄の名前は「品番」)
  const label = String(rawLabel).replace(/[\s*＊]+$/u, '') || String(rawLabel);
  const lit = xpathLiteral(label);
  const after = 'following::*[self::input or self::select or self::textarea][not(@type="hidden") and not(@type="button") and not(@type="submit") and not(@type="checkbox") and not(@type="radio")][1]';
  const cands = [
    () => page.getByLabel(label, { exact: true }),
    () => page.getByRole('textbox', { name: label, exact: true }),
    () => page.getByRole('combobox', { name: label, exact: true }),
    () => page.locator(`xpath=(//*[not(self::script or self::style or self::option)][normalize-space(text())=${lit}])/${after}`),
    () => page.getByLabel(label),
    () => page.getByRole('textbox', { name: label }),
    () => page.getByRole('combobox', { name: label }),
    () => page.locator(`xpath=(//*[not(self::script or self::style or self::option)][contains(normalize-space(text()), ${lit})])/${after}`),
  ];
  const until = Date.now() + timeout;
  for (;;) {
    for (const mk of cands) {
      try {
        const loc = mk();
        const n = await loc.count();
        for (let i = 0; i < Math.min(n, 5); i++) {
          const one = loc.nth(i);
          if (await one.isVisible()) return one;
        }
      } catch {
        // 次の探し方へ
      }
    }
    if (Date.now() >= until) return null;
    await page.waitForTimeout(250);
  }
}

function firstLine(e, n = 160) {
  return String((e && e.message) || e).split('\n')[0].slice(0, n);
}

// 手順を順に流す。1つ失敗したらそこで止め、残りは skipped
async function runSteps(page, steps, ctx) {
  const { env, args, col } = ctx;
  const results = [];
  let failed = false;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (failed) {
      results.push({ i: i + 1, kind: st.kind, ok: false, skipped: true, ms: 0 });
      continue;
    }
    await col.snapshot();
    if (st.kind === 'click' || st.kind === 'save') {
      try {
        ctx.before = await page.screenshot();
      } catch {
        // 縮小用の控えが取れなくても手順は続ける
      }
    }
    const t0 = Date.now();
    const r = { i: i + 1, kind: st.kind, ok: true };
    try {
      switch (st.kind) {
        case 'open': {
          let id = null;
          let url;
          if (st.open === 'detail' || st.open === 'edit') {
            id = String(st.record ?? args.record ?? (await fetchLatestRecordId(env, args.appId)) ?? '');
            if (!id) throw new Error('開くレコードがありません(アプリにレコードが0件)');
            url = `${env.baseUrl}/k/${args.appId}/show#record=${id}${st.open === 'edit' ? '&mode=edit' : ''}`;
          } else if (st.open === 'create') {
            url = `${env.baseUrl}/k/${args.appId}/edit`;
          } else if (st.open === 'index') {
            url = `${env.baseUrl}/k/${args.appId}/`;
          } else {
            url = `${env.baseUrl}/k/admin/app/${args.appId}/plugin/config?pluginId=${encodeURIComponent(args.plugin)}`;
          }
          await page.goto(url, { waitUntil: 'load' });
          await page.waitForTimeout(args.wait);
          ctx.opened = { page: st.open, recordId: id, url: page.url() };
          break;
        }
        case 'click': {
          const v = st.click;
          const all = typeof v === 'string'
            ? page.getByText(v.replace(/^text=/, '').replace(/^(["'])(.*)\1$/, '$2')).filter({ visible: true })
            : page.getByRole(v.role, { name: v.name }).filter({ visible: true });
          await clickable(all, 5000);
          await page.waitForLoadState('load').catch(() => {});
          await page.waitForTimeout(300);
          r.text = await stepText(page);
          break;
        }
        case 'fill': {
          const loc = await findField(page, st.fill.label);
          if (!loc) throw new Error(`項目「${st.fill.label}」の入力欄が見つかりません`);
          await loc.fill(String(st.fill.value), { timeout: 5000 });
          break;
        }
        case 'select': {
          const value = String(st.select.value);
          let loc = st.select.label === undefined ? null : await findField(page, st.select.label, 3000);
          // ラベルで見つからない(または無い)時は、その選択肢を持つ選択欄(後ろ=モーダル側から)
          if (!loc) loc = await selectHolding(page, value);
          if (!loc) throw new Error(st.select.label === undefined ? `選択肢「${value}」を持つ選択欄が見つかりません` : `項目「${st.select.label}」の選択欄が見つかりません(選択肢「${value}」を持つ選択欄もありません)`);
          const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
          if (tag === 'select') {
            // 選択肢の文字は完全一致 → 前方一致 → 部分一致(「RM-401」で「RM-401 新規ワッシャー」を選べる)
            const optValue = await loc.evaluate((el, want) => {
              const opts = [...el.options];
              const t = (o) => o.textContent.trim();
              const hit = opts.find((o) => t(o) === want) || opts.find((o) => o.value === want) || opts.find((o) => t(o).startsWith(want)) || opts.find((o) => t(o).includes(want));
              return hit ? hit.value : null;
            }, value);
            if (optValue === null) throw new Error(`選択肢「${value}」がありません`);
            await loc.selectOption(optValue, { timeout: 3000 });
          } else {
            // 見た目だけの選択欄: 開いて、選択肢(role=option か文字)を押す。入力できる欄なら入力する
            await loc.click({ timeout: 3000 });
            const opt = page.getByRole('option', { name: value, exact: true }).filter({ visible: true }).first();
            if (await opt.count()) await opt.click({ timeout: 3000 });
            else await page.getByText(value, { exact: true }).filter({ visible: true }).first().click({ timeout: 3000 });
          }
          break;
        }
        case 'press':
          await page.keyboard.press(st.press);
          await page.waitForTimeout(200);
          break;
        case 'save': {
          const before = page.url();
          let btn = page.getByRole('button', { name: '保存', exact: true }).filter({ visible: true }).first();
          if (!(await btn.count())) btn = page.getByRole('button', { name: '保存' }).filter({ visible: true }).first();
          await btn.click({ timeout: 5000 });
          // 遷移(URL が変わる or document が読み直される)を最大 6 秒待つ。入力エラーで留まる場合はそのまま次へ
          const loadsBefore = col.loads;
          const until = Date.now() + 6000;
          while (Date.now() < until && page.url() === before && col.loads === loadsBefore) await page.waitForTimeout(150);
          await page.waitForLoadState('load').catch(() => {});
          await page.waitForTimeout(args.wait > 1000 ? 1000 : args.wait);
          const id = recordIdFromUrl(page.url());
          if (id) ctx.opened = { page: 'detail', recordId: id, url: page.url() };
          r.text = await stepText(page);
          break;
        }
        case 'expect': {
          const timeout = st.expect.timeout ?? 5000;
          // exact: true は文字全体が一致する物だけ(「未登録」が項目名「マスター未登録」に当たらないように)
          const loc = page.getByText(st.expect.text, { exact: st.expect.exact === true }).filter({ visible: true }).first();
          try {
            await loc.waitFor({ state: 'visible', timeout });
          } catch {
            throw new Error(`「${st.expect.text}」が画面に出ませんでした(${timeout}ms)`);
          }
          r.text = await stepText(page);
          break;
        }
        case 'wait':
          await page.waitForTimeout(st.wait);
          break;
        case 'read': {
          // read は見出しだけでなく今の画面の文字(ダイアログがあればその本文)
          const sc = await readScreen(page);
          r.text = String(sc.dialog || sc.text || '').slice(0, 600);
          break;
        }
        default:
          throw new Error('unknown step');
      }
    } catch (e) {
      r.ok = false;
      r.error = firstLine(e);
      failed = true;
    }
    r.ms = Date.now() - t0;
    r.url = page.url();
    const rid = recordIdFromUrl(r.url);
    if (rid) r.recordId = rid;
    results.push(r);
  }
  return results;
}

// 手順の流れを1枚のページでやって、ページ結果 + actions を返す
async function probeActions(context, steps, ctx) {
  const { args, shots } = ctx;
  const page = await context.newPage();
  const col = createCollector(page, new URL(ctx.env.baseUrl).hostname);
  await page.addInitScript(kinProbeInitScript);
  const start = Date.now();
  ctx.col = col;
  const actions = await runSteps(page, steps, ctx);
  await col.snapshot();
  const ms = Date.now() - start;
  const { events, eventOrder } = col.aggregate();
  const screen = await readScreen(page);
  const url = page.url();
  let last = null;
  try {
    last = await page.screenshot();
  } catch {
    // 画面が撮れなければ「なし」のコマ
  }
  if (args.screenshot && last) writeFileSync(path.join(args.screenshot, 'actions.png'), last);
  if (shots) {
    if (ctx.before) shots.set('before', ctx.before);
    if (last) shots.set('last', last);
  }
  const result = {
    name: 'actions', url, ms,
    consoleErrors: col.consoleErrors, pageErrors: col.pageErrors, failedRequests: col.failedRequests, ignored: col.ignored,
    events, eventOrder, loads: col.loads,
  };
  await page.close();
  return { result, actions, screen };
}

// ---- ログイン ---------------------------------------------------------------

async function login(context, baseUrl, username, password) {
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: 'load' });
    await page.fill('input[name="username"]', username).catch(() => {});
    await page.fill('input[name="password"]', password).catch(() => {});

    let submitted = false;
    for (const sel of ['button[type="submit"]', 'input[type="submit"]', '.login-button']) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        submitted = true;
        break;
      }
    }
    if (!submitted) {
      await page.press('input[name="password"]', 'Enter').catch(() => {});
    }

    try {
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 10000 });
    } catch {
      // タイムアウトしても下の判定で失敗を検出する
    }
    await page.waitForLoadState('load').catch(() => {});

    const stillHasPasswordField = await page.$('input[name="password"]');
    const stillOnLogin = page.url().includes('/login');
    if (stillHasPasswordField || stillOnLogin) {
      throw new LoginError('ログインに失敗しました(ユーザー名またはパスワードを確認してください)');
    }
  } finally {
    await page.close();
  }
}

// ---- REST: 最新レコードの取得 -------------------------------------------------

async function fetchLatestRecordId(env, appId) {
  const qs = new URLSearchParams();
  qs.set('app', appId);
  qs.set('query', 'order by $id desc limit 1');
  qs.append('fields[0]', '$id');
  const url = `${env.baseUrl}/k/v1/records.json?${qs.toString()}`;
  const res = await fetch(url, { headers: authHeaders(env) });
  if (!res.ok) throw new Error(`records.json ${res.status}`);
  const data = await res.json();
  const rec = data && Array.isArray(data.records) ? data.records[0] : undefined;
  return rec && rec.$id ? rec.$id.value : null;
}

// ---- summary ---------------------------------------------------------------

function shortEventType(type) {
  const parts = String(type).split('.');
  return parts[parts.length - 1];
}

function buildEventsSummaryPart(pages) {
  const parts = [];
  for (const p of pages) {
    if (p.skipped) continue;
    for (const e of p.events) if (e.count > 0) parts.push(`${p.name}.${shortEventType(e.type)}×${e.count}`);
  }
  return parts.join(' ');
}

function pageHasError(p) {
  return !p.skipped && (p.consoleErrors.length > 0 || p.pageErrors.length > 0 || p.failedRequests.length > 0);
}

function buildSummary(pages) {
  const eventsPart = buildEventsSummaryPart(pages);
  const errorPage = pages.find(pageHasError);
  let head;
  if (!errorPage) {
    const visited = pages.filter((p) => !p.skipped).length;
    head = `mod からの報告: ${visited}画面 エラーなし`;
  } else {
    const label = PAGE_LABEL[errorPage.name] || errorPage.name;
    let detail;
    if (errorPage.pageErrors.length) {
      const e = errorPage.pageErrors[0];
      const loc = extractFileLine(e.at);
      detail = `${label} ${e.message}${loc ? ` (${loc})` : ''}`;
    } else if (errorPage.consoleErrors.length) {
      const e = errorPage.consoleErrors[0];
      const loc = extractFileLine(e.location);
      detail = `${label} console.error: ${e.text}${loc ? ` (${loc})` : ''}`;
    } else {
      const f = errorPage.failedRequests[0];
      detail = `${label} ${f.status} ${f.url}`;
    }
    head = `mod からの報告: ${detail}`;
  }
  let summary = eventsPart ? `${head} / events ${eventsPart}` : head;
  if (summary.length > 300) summary = `${summary.slice(0, 299)}…`;
  return summary;
}

// 出力を1行の JSON で書く。--sheet が渡されていたら、どの終わり方でも sheet(パス or null)を必ず入れ、
// null の時は sheetError も入れる(「縮小パスが返らない」の再発防止: 出力は必ずここを通す)。
function emit(out, args) {
  if (args && args.thumbs && out.thumbs === undefined) {
    out.thumbs = [];
    out.thumbsError = '画面を開く前に終わったため縮小画像は作っていません';
  }
  if (args && args.sheet) {
    if (out.sheet === undefined) out.sheet = null;
    if (out.sheet === null && !out.sheetError) out.sheetError = '画面を開く前に終わったため縮小画像は作っていません';
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function emitSkipped(args, skipCode, reason, extra = {}) {
  const out = {
    ok: true,
    skipped: true,
    skipCode,
    reason,
    appId: args.appId,
    seconds: 0,
    pages: [],
    summary: `mod からの報告: 画面チェックは省略(${reason}・反映は済)`,
    ...extra,
  };
  if (args.sheet) {
    out.sheet = null;
    out.sheetError = `画面チェックを省略したため縮小画像は作っていません(${skipCode})`;
  }
  emit(out, args);
}

// ---- 一覧画像(--sheet) ------------------------------------------------------
// 縮小1枚: 最大2コマ・1コマ 540px 幅(2コマで横 1080px)。撮れなかったコマは「なし」。
const SHEET_CELL_W = 540;
const SHEET_LABEL = { ...PAGE_LABEL, before: '操作の直前', last: '最後の画面' };

async function buildSheet(browser, shots, outPath, names) {
  const abs = path.resolve(outPath);
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  names = names.slice(0, 2);
  if (!names.length) throw new Error('並べる画面がありません');
  const w = SHEET_CELL_W;
  const cells = names.map((name) => {
    const buf = shots && shots.get(name);
    const body = buf
      ? `<img src="data:image/png;base64,${buf.toString('base64')}" style="display:block;width:${w}px;box-sizing:border-box;border:1px solid #999">`
      : `<div style="width:${w}px;height:${Math.round(w * 0.62)}px;box-sizing:border-box;background:#ddd;border:1px solid #bbb;color:#777;display:flex;align-items:center;justify-content:center;font-size:18px">なし</div>`;
    return `<div style="width:${w}px">${body}<div style="font:bold 14px sans-serif;margin-top:4px;color:#333">${esc(SHEET_LABEL[name] || name)}</div></div>`;
  });
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff"><div id="sheet" style="display:flex;width:fit-content;background:#fff">${cells.join('')}</div></body>`;
  const page = await browser.newPage({ viewport: { width: 1080, height: 600 } });
  try {
    await page.setContent(html);
    const png = await page.locator('#sheet').screenshot();
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, png);
  } finally {
    await page.close();
  }
  return abs;
}

// ---- 画面の縮小(--thumbs) ---------------------------------------------------
// pane の Svg(<image href="data:image/jpeg;base64,…">)は全体 131072 字が上限。base64 が THUMB_MAX_CHARS を超えたら
// 540px/q70 → 480px/q70 → 480px/q50 の順に落とし、それでも超えたらその画面は出さない。
const THUMB_MAX_CHARS = 125000;
const THUMB_TRIES = [{ width: 540, quality: 70 }, { width: 480, quality: 70 }, { width: 480, quality: 50 }];

async function renderThumb(browser, png, width, quality) {
  const page = await browser.newPage({ viewport: { width: width + 20, height: 600 } });
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0"><img id="t" src="data:image/png;base64,${png.toString('base64')}" style="display:block;width:${width}px"></body>`);
    const el = page.locator('#t');
    const box = await el.boundingBox();
    const buf = await el.screenshot({ type: 'jpeg', quality });
    return { buf, width: Math.round(box.width), height: Math.round(box.height) };
  } finally {
    await page.close();
  }
}

async function buildThumbs(browser, shots, dir, names) {
  const abs = path.resolve(dir);
  mkdirSync(abs, { recursive: true });
  const thumbs = [];
  const skipped = [];
  for (const name of names.slice(0, 3)) {
    const png = shots && shots.get(name);
    if (!png) { skipped.push(`${name}: 画面が撮れていません`); continue; }
    let done = null;
    for (const t of THUMB_TRIES) {
      const r = await renderThumb(browser, png, t.width, t.quality);
      const chars = r.buf.toString('base64').length;
      if (chars <= THUMB_MAX_CHARS) { done = { ...r, chars }; break; }
    }
    if (!done) { skipped.push(`${name}: 小さくしても大きすぎます`); continue; }
    const file = path.join(abs, `${name}.jpg`);
    writeFileSync(file, done.buf);
    thumbs.push({ page: name, path: file, width: done.width, height: done.height, chars: done.chars });
  }
  return { thumbs, skipped };
}

async function addThumbs(out, browser, shots, dir, names) {
  try {
    const { thumbs, skipped } = await buildThumbs(browser, shots, dir, names.filter((n) => n === 'index' || n === 'detail' || n === 'config'));
    out.thumbs = thumbs;
    if (!thumbs.length) out.thumbsError = skipped.join(' / ') || '縮小する画面がありません';
    else if (skipped.length) out.thumbsSkipped = skipped;
  } catch (e) {
    out.thumbs = [];
    out.thumbsError = firstLine(e, 120);
  }
}

// 通常実行の縮小に並べる画面: plugin があれば 設定|詳細、無ければ 詳細|一覧(頼まれた画面の中から最大2)
function pickSheetPages(args, pageNames) {
  const preferred = args.plugin ? ['config', 'detail', 'index'] : ['detail', 'index'];
  return preferred.filter((n) => pageNames.includes(n)).slice(0, 2);
}

async function addSheet(out, browser, shots, args, names) {
  try {
    out.sheet = await buildSheet(browser, shots, args.sheet, names);
    out.sheetPages = names.slice(0, 2);
  } catch (e) {
    out.sheet = null;
    out.sheetError = firstLine(e, 120);
  }
}

// ---- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.appId) {
    throw new UsageError('appId を指定してください: kin-probe.mjs <appId> [--plugin <id>] [--record <id>] [--pages a,b,c] [--screenshot <dir>] [--sheet <out.png>] [--thumbs <dir>] [--actions <file.json>] [--wait <ms>]');
  }

  // 手順は接続情報より先に検証する(不正ならブラウザも env も触らない)
  const steps = args.actions ? loadActions(args.actions, { plugin: args.plugin }) : null;

  const env = loadKinEnv(); // KinEnvError は呼び出し側の catch で処理する

  // 本番では画面への書き込み(入力・選択・キー・保存・クリック)は拒否。ブラウザも起こさない
  if (steps && env.mode === 'prod' && hasWriteStep(steps)) {
    emit({ ok: false, error: { code: 'prod_denied', message: '本番では画面の操作(入力・選択・クリック・保存)はできません(開発環境だけ)' } }, args);
    return;
  }

  if (args.screenshot) mkdirSync(args.screenshot, { recursive: true });

  const skippedActions = steps ? { actions: steps.map((s, i) => ({ i: i + 1, kind: s.kind, ok: false, skipped: true, ms: 0 })) } : {};

  applyNativeLibs();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: findExecutable(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  } catch {
    emitSkipped(args, 'no-browser', '画面チェック用の chromium がありません(/kin doctor を参照)', skippedActions);
    return;
  }

  const overallStart = Date.now();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await login(context, env.baseUrl, env.username, env.password);
    } catch (e) {
      if (!(e instanceof LoginError)) throw e;
      emitSkipped(args, 'login', 'ログインできませんでした(SSO・2要素・パスワードの可能性)', skippedActions);
      return;
    }

    const shots = args.sheet || args.thumbs ? new Map() : null;

    if (steps) {
      const ctx = { env, args, shots, before: null, opened: null };
      const { result, actions, screen } = await probeActions(context, steps, ctx);
      const failed = actions.find((a) => !a.ok && !a.skipped);
      const ok = !failed && !pageHasError(result);
      const seconds = Math.round(((Date.now() - overallStart) / 1000) * 100) / 100;
      let summary = buildSummary([result]);
      if (failed) {
        const msg = `mod からの報告: 手順 ${failed.i}/${actions.length}(${failed.kind})で失敗: ${failed.error}`;
        const ev = buildEventsSummaryPart([result]);
        summary = (ev ? `${msg} / events ${ev}` : msg);
        if (summary.length > 300) summary = `${summary.slice(0, 299)}…`;
      }
      const out = { ok, appId: args.appId, seconds, pages: [result], actions, opened: ctx.opened, screen, summary };
      if (args.sheet) await addSheet(out, browser, shots, args, ctx.before ? ['before', 'last'] : ['last']);
      emit(out, args);
      return;
    }

    const pageNames = resolvePageNames(args);
    const results = [];
    for (const name of pageNames) {
      if (name === 'detail') {
        let recordId = args.record;
        if (!recordId) {
          recordId = await fetchLatestRecordId(env, args.appId);
          if (!recordId) {
            results.push(skippedPage('detail'));
            continue;
          }
        }
        const url = `${env.baseUrl}/k/${args.appId}/show#record=${recordId}`;
        results.push(await probePage(context, 'detail', url, { wait: args.wait, screenshotDir: args.screenshot, shots, recordId }));
      } else if (name === 'config') {
        const url = `${env.baseUrl}/k/admin/app/${args.appId}/plugin/config?pluginId=${encodeURIComponent(args.plugin)}`;
        results.push(await probePage(context, 'config', url, { wait: args.wait, screenshotDir: args.screenshot, shots }));
      } else if (name === 'index') {
        const url = `${env.baseUrl}/k/${args.appId}/`;
        results.push(await probePage(context, 'index', url, { wait: args.wait, screenshotDir: args.screenshot, shots }));
      }
    }

    const ok = results.every((p) => !pageHasError(p));
    const seconds = Math.round(((Date.now() - overallStart) / 1000) * 100) / 100;
    const summary = buildSummary(results);
    const out = { ok, appId: args.appId, seconds, pages: results, summary };
    if (args.sheet) await addSheet(out, browser, shots, args, pickSheetPages(args, pageNames));
    if (args.thumbs) await addThumbs(out, browser, shots, args.thumbs, pageNames);
    emit(out, args);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const code = err instanceof KinEnvError ? err.code : (err && err.code) || 'error';
    const message = (err && err.message) || String(err);
    let args = null;
    try {
      args = parseArgs(process.argv.slice(2));
    } catch {
      // 引数が読めなくても失敗の JSON は返す
    }
    const out = { ok: false, error: { code, message } };
    if (args && args.sheet) {
      out.sheet = null;
      out.sheetError = `エラーで終わったため縮小画像は作っていません(${code})`;
    }
    emit(out, args);
    process.exitCode = err instanceof KinEnvError ? 2 : 1;
  });
}
