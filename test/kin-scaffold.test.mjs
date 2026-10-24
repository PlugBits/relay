// tools/kin-scaffold.mjs のテスト。生成物を @kintone/plugin-packer で pack できることも確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { packPluginFromManifest } from '@kintone/plugin-packer/from-manifest';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'kin-scaffold.mjs');
const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { json: JSON.parse(r.stdout.trim().split('\n').pop()), stdout: r.stdout, status: r.status };
};
// vm 内で作った配列は別 realm なので、JSON に直して比べる
const deq = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const tmp = () => mkdtempSync(join(tmpdir(), 'kin-scaffold-'));

const KINDS = ['event', 'config-only', 'header-button', 'index-band', 'detail-notice'];
const REQUIRED = {
  event: ['fieldCode'],
  'config-only': ['fieldCode'],
  'header-button': ['fieldCode'],
  'index-band': ['fieldCodes', 'viewIds'],
  'detail-notice': ['fieldCodes'],
};
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'assets');

for (const kind of KINDS) {
  test(`${kind}: 生成して pack できる`, async () => {
    const root = tmp();
    try {
      const { json, stdout } = run(['demo-x', kind, '--root', root, '--title', 'デモ', '--brand', 'PlugBits']);
      assert.equal(json.ok, true);
      assert.equal(json.pluginIdHint, null);
      for (const f of ['manifest.json', 'config.html', 'config.js', 'desktop.js', 'mobile.js', 'icon.png', '.keys/demo-x.ppk']) {
        assert.ok(json.files.includes(f), f);
        assert.ok(existsSync(join(json.dir, f)), f);
      }
      const ppk = readFileSync(join(json.dir, '.keys/demo-x.ppk'), 'utf8');
      assert.match(ppk, /BEGIN RSA PRIVATE KEY/);
      assert.ok(!stdout.includes('PRIVATE KEY'));
      const desktop = readFileSync(join(json.dir, 'desktop.js'), 'utf8');
      assert.match(desktop, /'use strict'/);
      assert.match(desktop, /kintone\.\$PLUGIN_ID/);
      assert.match(desktop, /内部 DOM/);
      if (kind === 'event') {
        for (const e of ['app.record.create.submit', 'app.record.edit.submit', 'app.record.detail.show', 'app.record.index.show']) {
          assert.ok(desktop.includes(e), e);
        }
      }
      assert.ok(!desktop.replace(/^\s*\/\/.*$/gm, '').includes('querySelector'), 'コメント以外で querySelector を使わない');
      for (const f of ['desktop.js', 'mobile.js', 'config.js']) {
        const r = spawnSync(process.execPath, ['--check', join(json.dir, f)], { encoding: 'utf8' });
        assert.equal(r.status, 0, f + ': ' + r.stderr);
      }
      const mf = JSON.parse(readFileSync(join(json.dir, 'manifest.json'), 'utf8'));
      deq(mf.desktop, { js: ['relay-ui.js', 'desktop.js'], css: ['51-modern-default.css'] });
      deq(mf.mobile, { js: ['relay-ui.js', 'mobile.js'], css: ['51-modern-default.css'] });
      deq(mf.config.css, ['51-modern-default.css', 'config.css']);
      deq(mf.config.js, ['relay-config.js', 'config.js']);
      deq(mf.config.required_params, REQUIRED[kind]);
      assert.ok(readFileSync(join(json.dir, '51-modern-default.css')).equals(readFileSync(join(ASSETS, '51-modern-default.css'))));
      assert.ok(readFileSync(join(json.dir, 'relay-ui.js')).equals(readFileSync(join(ASSETS, 'relay-ui.js'))));
      assert.ok(json.files.includes('relay-config.js'));
      assert.ok(readFileSync(join(json.dir, 'relay-config.js')).equals(readFileSync(join(ASSETS, 'relay-config.js'))));
      const css = readFileSync(join(json.dir, 'config.css'), 'utf8');
      assert.ok(!css.includes('#'), 'config.css に色指定を置かない');
      assert.ok(!/(box-shadow|border-radius|font-family|background|color)/.test(css));
      const cfg = readFileSync(join(json.dir, 'config.js'), 'utf8');
      assert.match(cfg, /RelayConfig\.mount\(/);
      assert.match(cfg, /ctl\.save\(\)/);
      assert.match(cfg, /ctl\.cancel\(\)/);
      assert.match(cfg, /document\.getElementById\('settings'\)/);
      assert.ok(!/innerHTML|querySelector/.test(cfg.replace(/^\s*\/\/.*$/gm, '')));
      const rc = readFileSync(join(json.dir, 'relay-config.js'), 'utf8');
      assert.match(rc, /kintone\.plugin\.app\.setConfig/);
      assert.match(rc, /\/k\/admin\/app\/' \+ appId \+ '\/plugin\//);
      assert.match(rc, /\/k\/v1\/app\/form\/fields/);
      const html = readFileSync(join(json.dir, 'config.html'), 'utf8');
      assert.ok(html.lastIndexOf('PlugBits') > html.lastIndexOf('kintoneplugin-button-dialog-ok'));
      assert.equal(html.split('PlugBits').length, 2);
      for (const c of ['kintoneplugin-button-dialog-ok', 'kintoneplugin-button-dialog-cancel', 'kintoneplugin-alert', 'kintoneplugin-row', 'id="settings"', 'id="error"']) {
        assert.ok(html.includes(c), c);
      }
      // --brand ありでも config.html 以外には PlugBits が出ない
      for (const f of json.files.filter((x) => !x.startsWith('.keys') && x !== 'icon.png' && x !== 'config.html' && x !== 'relay-ui.js' && x !== 'relay-config.js')) {
        assert.ok(!readFileSync(join(json.dir, f), 'utf8').includes('PlugBits'), f);
      }
      // 既存の鍵で pack できる
      const res = await packPluginFromManifest(join(json.dir, 'manifest.json'), ppk);
      assert.ok(res.id && res.plugin.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('--fields-json: コメントに入り、config は実行時 API', () => {
  const root = tmp();
  try {
    const f = join(root, 'form.json');
    writeFileSync(f, JSON.stringify({ ok: true, fields: [{ code: 'customer_name', label: '顧客名', type: 'SINGLE_LINE_TEXT' }] }));
    const { json } = run(['with-fields', 'event', '--root', root, '--fields-json', f]);
    assert.ok(!readFileSync(join(json.dir, 'config.html'), 'utf8').includes('提供:'), '既定では提供行を出さない');
    assert.equal(json.ok, true);
    const d = readFileSync(join(json.dir, 'desktop.js'), 'utf8');
    assert.match(d, /customer_name\s+顧客名/);
    assert.ok(!readFileSync(join(json.dir, 'config.js'), 'utf8').includes('customer_name'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('name の検証', () => {
  const root = tmp();
  try {
    for (const bad of ['Bad_Name', 'a b', '../x']) {
      const { json } = run([bad, 'event', '--root', root]);
      assert.equal(json.ok, false);
      assert.equal(json.error.code, 'bad_name');
    }
    assert.equal(run(['ok-1', 'nope', '--root', root]).json.error.code, 'bad_kind');
    assert.match(run(['ok-1', 'nope', '--root', root]).json.error.message, /header-button/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('既存の空でないディレクトリは拒否', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'plugins', 'taken'), { recursive: true });
    writeFileSync(join(root, 'plugins', 'taken', 'x.txt'), 'x');
    const { json } = run(['taken', 'event', '--root', root]);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'exists');
    assert.equal(readFileSync(join(root, 'plugins', 'taken', 'x.txt'), 'utf8'), 'x');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--brand 無しなら生成物のどこにも PlugBits が出ない', () => {
  for (const kind of KINDS) {
    const root = tmp();
    try {
      const { json } = run(['nb', kind, '--root', root]);
      for (const f of json.files.filter((x) => !x.startsWith('.keys') && x !== 'icon.png' && x !== 'relay-ui.js' && x !== 'relay-config.js')) {
        assert.ok(!readFileSync(join(json.dir, f), 'utf8').includes('PlugBits'), `${kind}/${f}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('kind ごとの本体と設定', () => {
  const gen = (kind) => {
    const root = tmp();
    const { json } = run(['k1', kind, '--root', root]);
    const rd = (f) => readFileSync(join(json.dir, f), 'utf8');
    const o = { d: rd('desktop.js'), m: rd('mobile.js'), c: rd('config.js'), h: rd('config.html') };
    rmSync(root, { recursive: true, force: true });
    return o;
  };
  // config.js の items を取り出す(RelayConfig.mount に渡った値)
  const itemsOf = (cfgJs) => {
    let got;
    vm.runInNewContext(cfgJs, {
      RelayConfig: { mount: (_r, o) => { got = o.items; return { save() {}, cancel() {} }; } },
      document: { getElementById: () => ({ addEventListener() {} }) },
      kintone: { $PLUGIN_ID: 'p' },
    });
    return got;
  };
  const types = (items) => items.map((i) => `${i.key}:${i.type}`);

  const ev = gen('event');
  deq(types(itemsOf(ev.c)), ['fieldCode:field']);
  deq(types(itemsOf(gen('config-only').c)), ['fieldCode:field']);

  const hb = gen('header-button');
  deq(types(itemsOf(hb.c)), ['fieldCode:field', 'buttonLabel:text']);
  assert.match(hb.d, /app\.record\.index\.show/);
  assert.match(hb.d, /RelayUI\.headerButton/);
  assert.match(hb.d, /RelayUI\.togglePanel/);
  assert.match(hb.d, /'relay-hb-' \+ PLUGIN_ID/);
  assert.match(hb.m, /mobile\.app\.record\.index\.show/);
  assert.match(hb.m, /mobile: true/);

  const ib = gen('index-band');
  const ibItems = itemsOf(ib.c);
  deq(types(ibItems), ['fieldCodes:fields', 'viewIds:views']);
  deq(ibItems[0].types, ['NUMBER', 'CALC']);
  assert.equal(ibItems[0].min, 1);
  assert.match(ib.d, /getQueryCondition/);
  assert.match(ib.d, /offset/);
  assert.match(ib.d, /RelayUI\.band/);
  assert.match(ib.d, /10,000件まで/);
  assert.match(ib.d, /event\.viewId/);
  assert.match(ib.d, /viewIds/);
  assert.match(ib.d, /fieldCodes__labels/);
  assert.match(ib.m, /kintone\.mobile\.app\.getQueryCondition/);
  assert.match(ib.m, /mobile\.app\.record\.index\.show/);

  const dn = gen('detail-notice');
  deq(types(itemsOf(dn.c)), ['fieldCodes:fields', 'noticeText:text']);
  assert.match(dn.d, /app\.record\.detail\.show/);
  assert.match(dn.d, /RelayUI\.notice/);
  assert.match(dn.d, /RelayUI\.clearNotice/);
  assert.match(dn.d, /tone: 'warn'/);
  assert.match(dn.m, /mobile\.app\.record\.detail\.show/);
  assert.ok(!dn.d.includes('/k/v1/app/form'), '本体で REST を引かない');
});

// ---- 生成された本体を偽の kintone で動かす ----
function runBody(code, config, event, extra = {}) {
  const calls = { band: [], notice: [], clear: [] };
  const handlers = {};
  const ctx = {
    kintone: {
      $PLUGIN_ID: 'pid',
      plugin: { app: { getConfig: () => config } },
      events: { on: (n, f) => { handlers[n] = f; } },
      app: { getQueryCondition: () => '', getId: () => 1 },
      api: Object.assign(
        async () => ({ records: [{ a: { value: '3' }, b: { value: '4' } }, { a: { value: '2' }, b: { value: 'x' } }] }),
        { url: (p) => p },
      ),
    },
    RelayUI: {
      band: (o) => calls.band.push(o),
      notice: (o) => calls.notice.push(o),
      clearNotice: (id) => calls.clear.push(id),
    },
    ...extra,
  };
  vm.runInNewContext(code, ctx);
  const h = handlers['app.record.index.show'] || handlers['app.record.detail.show'];
  const r = h ? h(event) : null;
  return { calls, handlers, r };
}
const genBody = (kind) => {
  const root = tmp();
  const { json } = run(['b1', kind, '--root', root]);
  const o = { d: readFileSync(join(json.dir, 'desktop.js'), 'utf8') };
  rmSync(root, { recursive: true, force: true });
  return o.d;
};

test('index-band 本体: viewIds・欄ごとの合計・旧設定・壊れた JSON', async () => {
  const d = genBody('index-band');
  const cfg = { fieldCodes: '["a","b"]', fieldCodes__labels: '{"a":"売上","b":"原価"}', viewIds: '["5"]' };
  // 対象外の一覧では帯を出さない
  let r = runBody(d, cfg, { viewId: 9 });
  assert.equal(r.calls.band.length, 0);
  deq(r.calls.clear, ['relay-band-pid']);
  // 対象の一覧
  r = runBody(d, cfg, { viewId: 5 });
  await new Promise((res) => setTimeout(res, 20));
  const last = r.calls.band[r.calls.band.length - 1];
  deq(last.items, [
    { label: '件数', value: 2 },
    { label: '売上 合計', value: 5 },
    { label: '原価 合計', value: 4 },
  ]);
  // __all__ ならどの一覧でも
  r = runBody(d, { ...cfg, viewIds: '["__all__"]' }, { viewId: 99 });
  assert.equal(r.calls.band[0].loading, true);
  // 旧キー(fieldCode 1 つ・viewIds 無し)
  r = runBody(d, { fieldCode: 'a', fieldLabel: '売上' }, { viewId: 1 });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.calls.band[r.calls.band.length - 1].items[1].label, '売上 合計');
  // 壊れた JSON は何も出さない(ハンドラも付けない)
  r = runBody(d, { fieldCodes: '{oops', viewIds: '[' }, { viewId: 1 });
  assert.equal(Object.keys(r.handlers).length, 0);
});

test('detail-notice 本体: 未入力の欄を 1 つの注意にまとめる・旧設定・壊れた JSON', () => {
  const d = genBody('detail-notice');
  const rec = { a: { value: '' }, b: { value: 'x' }, c: { value: [] } };
  const cfg = { fieldCodes: '["a","b","c"]', fieldCodes__labels: '{"a":"顧客","b":"件名","c":"担当"}' };
  let r = runBody(d, cfg, { record: rec });
  assert.equal(r.calls.notice.length, 1);
  assert.equal(r.calls.notice[0].text, '「顧客」「担当」が未入力です');
  r = runBody(d, { ...cfg, noticeText: '入力して' }, { record: rec });
  assert.equal(r.calls.notice[0].text, '入力して');
  r = runBody(d, cfg, { record: { a: { value: '1' }, b: { value: '1' }, c: { value: ['x'] } } });
  assert.equal(r.calls.notice.length, 0);
  assert.equal(r.calls.clear.length, 1);
  r = runBody(d, { fieldCode: 'a', fieldLabel: '顧客' }, { record: rec });
  assert.equal(r.calls.notice[0].text, '「顧客」が未入力です');
  r = runBody(d, { fieldCodes: 'nope' }, { record: rec });
  assert.equal(Object.keys(r.handlers).length, 0);
});

// ---- relay-config.js(偽 DOM)----
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this._text = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
  }
  get firstChild() { return this.children[0] || null; }
  set textContent(t) { this.children.forEach((c) => (c.parentNode = null)); this.children = []; this._text = String(t); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t) { (this.listeners[t] || []).forEach((f) => f({ target: this })); }
  all(pred, out = []) {
    for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); }
    return out;
  }
  byClass(cls) { return this.all((e) => e.className.split(' ').includes(cls)); }
  byTag(tag) { return this.all((e) => e.tagName === tag.toUpperCase()); }
}
const FORM = {
  properties: {
    price: { code: 'price', label: '単価', type: 'NUMBER' },
    total: { code: 'total', label: '合計', type: 'CALC' },
    name: { code: 'name', label: '名前', type: 'SINGLE_LINE_TEXT' },
    rec: { code: 'rec', label: 'レコード番号', type: 'RECORD_NUMBER' },
    kind: { code: 'kind', label: '種別', type: 'DROP_DOWN', options: { 乙: { label: '乙', index: '1' }, 甲: { label: '甲', index: '0' } } },
    tags: { code: 'tags', label: 'タグ', type: 'CHECK_BOX', options: { b: { label: 'b', index: '1' }, a: { label: 'a', index: '0' } } },
    tbl: {
      code: 'tbl',
      label: '明細',
      type: 'SUBTABLE',
      fields: { qty: { code: 'qty', label: '数量', type: 'NUMBER' }, memo: { code: 'memo', label: 'メモ', type: 'SINGLE_LINE_TEXT' } },
    },
  },
};
const VIEWS = {
  views: {
    B: { id: '20', name: '集計', index: '1', type: 'LIST' },
    A: { id: '10', name: '全件', index: '0', type: 'LIST' },
  },
};
function boot({ config = {}, fail = null } = {}) {
  const doc = { createElement: (t) => new FakeEl(t) };
  const saved = [];
  const loc = { href: '' };
  const apiCalls = [];
  const ctx = {
    document: doc,
    window: { location: loc },
    kintone: {
      $PLUGIN_ID: 'pid',
      app: { getId: () => 7 },
      api: Object.assign(
        async (path, _m, params) => {
          apiCalls.push([path, params]);
          if (fail) throw new Error(fail);
          if (path === '/k/v1/app/form/fields') return FORM;
          if (path === '/k/v1/app/views.json') return VIEWS;
          if (path === '/k/v1/apps.json') {
            const all = Array.from({ length: 130 }, (_, i) => ({ appId: String(i + 1), name: 'app' + (i + 1) }));
            return { apps: all.slice(params.offset, params.offset + params.limit) };
          }
          throw new Error('unexpected ' + path);
        },
        { url: (p) => p },
      ),
      plugin: { app: { getConfig: () => config, setConfig: (o) => saved.push(o) } },
    },
  };
  ctx.window.RelayConfig = undefined;
  vm.runInNewContext(readFileSync(join(ASSETS, 'relay-config.js'), 'utf8'), ctx);
  return { RC: ctx.window.RelayConfig, saved, loc, apiCalls, root: new FakeEl('div'), errorEl: new FakeEl('div') };
}
const optTexts = (select) => select.byTag('option').map((o) => o.textContent);

test('relay-config: _internal の候補の並びと絞り込み', () => {
  const { RC } = boot();
  const I = RC._internal;
  const form = I.parseForm(FORM.properties);
  const texts = (item) => I.fieldCandidates(form, item).map((c) => c.text);
  deq(texts({ types: ['NUMBER', 'CALC'] }), ['単価(price)', '合計(total)', '明細 › 数量(qty)']);
  deq(texts({ types: ['NUMBER', 'CALC'], subtable: false }), ['単価(price)', '合計(total)']);
  deq(texts({ types: ['RECORD_NUMBER'] }), ['レコード番号(rec)']);
  deq(texts({ types: ['SUBTABLE'] }), ['明細(tbl)']);
  const all = texts({});
  assert.ok(all.includes('明細 › メモ(memo)'));
  assert.ok(!all.includes('明細(tbl)'), '表そのものは types に SUBTABLE がある時だけ');
  deq(I.viewList(VIEWS.views), [{ value: '10', text: '全件' }, { value: '20', text: '集計' }]);
  deq(form.byCode.kind.options, ['甲', '乙']);
  assert.equal(I.checkNumber({ min: 1, max: 5 }, '9').error, '5 以下にしてください');
  assert.equal(I.checkNumber({ default: 3 }, '').value, '3');
  assert.ok(I.checkNumber({ required: true }, ' ').error);
  assert.ok(I.checkNumber({ step: 0.5, min: 0 }, '0.7').error);
  assert.equal(I.checkNumber({ step: 0.5, min: 0 }, '1.5').error, null);
  deq(I.parseArr('["a",1]'), ['a', '1']);
  deq(I.parseArr('{x'), []);
});

test('relay-config: mount → 候補・検証・保存(文字列だけ・__labels)', async () => {
  const b = boot({ config: { fieldCode: 'price' } });
  const ctl = b.RC.mount(b.root, {
    pluginId: 'pid',
    errorEl: b.errorEl,
    items: [
      { type: 'field', key: 'fieldCode', label: '欄', types: ['NUMBER', 'CALC'], required: true },
      { type: 'fields', key: 'fieldCodes', label: '欄たち', types: ['NUMBER', 'CALC'], min: 1, required: true },
      { type: 'views', key: 'viewIds', label: '一覧', min: 1, required: true, default: ['__all__'] },
      { type: 'view', key: 'viewId', label: '一覧1' },
      { type: 'app', key: 'appId', label: 'アプリ' },
      { type: 'field', key: 'optField', label: '選択肢の欄', types: ['DROP_DOWN', 'CHECK_BOX'] },
      { type: 'options', key: 'opts', label: '選択肢', of: 'optField' },
      { type: 'number', key: 'n', label: '数', min: 1, max: 10, default: 5 },
      { type: 'text', key: 't', label: '文', required: true, maxLength: 5 },
    ],
  });
  await ctl.ready;
  assert.equal(b.apiCalls.filter((c) => c[0] === '/k/v1/app/form/fields').length, 1, 'フォームは 1 回だけ');
  assert.equal(b.apiCalls.filter((c) => c[0] === '/k/v1/apps.json').length, 2, 'apps は 100 件ずつページを回す');
  const selects = b.root.byTag('select');
  deq(optTexts(selects[0]), ['選択してください', '単価(price)', '合計(total)', '明細 › 数量(qty)']);
  assert.equal(selects[0].value, 'price', '前回値が反映される');
  deq(optTexts(selects[1]).slice(0, 3), ['選択してください', 'すべての一覧', '全件']);
  assert.equal(optTexts(selects[2]).at(-1), 'app130(130)');
  // 既定の views は「すべての一覧」にチェック
  const boxes = b.root.byTag('input').filter((i) => i.attrs.type === undefined && i.type === 'checkbox');
  const viewBox = boxes.find((i) => i.value === '__all__');
  assert.equal(viewBox.checked, true);
  // kintoneplugin-* 以外のクラスを使わない(frame 内のセル用 relay-config-cell は表の中だけ)
  const classes = new Set(b.root.all(() => true).flatMap((e) => e.className.split(' ').filter(Boolean)));
  for (const c of classes) assert.match(c, /^kintoneplugin-|^title$/, c);

  // 必須が空 → setConfig は呼ばれず、その欄の下と errorEl に出る
  assert.equal(ctl.save(), false);
  assert.equal(b.saved.length, 0);
  assert.match(b.errorEl.textContent, /欄たち/);
  assert.match(b.errorEl.textContent, /文/);
  const alerts = b.root.byClass('kintoneplugin-alert').filter((a) => !a.hidden);
  assert.ok(alerts.length >= 2);

  // 選択肢は選んだ欄に追従する
  const optSel = selects[3];
  assert.equal(b.root.byClass('kintoneplugin-desc').some((d) => /先に対象の欄/.test(d.textContent)), true);
  optSel.value = 'kind';
  optSel.fire('change');
  const optBoxes = () => b.root.byTag('label').filter((l) => ['甲', '乙', 'a', 'b'].includes(l.textContent)).map((l) => l.textContent);
  deq(optBoxes(), ['甲', '乙']);
  optSel.value = 'tags';
  optSel.fire('change');
  deq(optBoxes(), ['a', 'b']);

  // 正しく入力して保存
  const pick = (v) => boxes.find((i) => i.value === v);
  pick('total').checked = true;
  pick('qty').checked = true;
  b.root.byTag('input').find((i) => i.className === 'kintoneplugin-input-text' && i.value === '5').value = '11';
  assert.equal(ctl.save(), false, '範囲外の数は止める');
  b.root.byTag('input').find((i) => i.value === '11').value = '';
  const texts = b.root.byTag('input').filter((i) => i.className === 'kintoneplugin-input-text');
  texts[texts.length - 1].value = '  ほげ ';
  b.root.byTag('input').find((i) => i.value === 'a' && i.type === 'checkbox').checked = true;
  assert.equal(ctl.save(), true);
  assert.equal(b.saved.length, 1);
  const o = b.saved[0];
  for (const v of Object.values(o)) assert.equal(typeof v, 'string');
  assert.equal(o.fieldCode, 'price');
  deq(JSON.parse(o.fieldCodes), ['total', 'qty']);
  deq(JSON.parse(o.fieldCodes__labels), { total: '合計', qty: '数量' });
  deq(JSON.parse(o.fieldCode__labels), { price: '単価' });
  deq(JSON.parse(o.viewIds), ['__all__']);
  assert.equal(o.n, '5', '空なら既定値');
  assert.equal(o.t, 'ほげ');
  deq(JSON.parse(o.opts), ['a']);
  assert.equal(b.errorEl.hidden, true);
  ctl.cancel();
  assert.equal(b.loc.href, '/k/admin/app/7/plugin/');
});

test('relay-config: 前回の欄が無い時は「見つかりません」で止める', async () => {
  const b = boot({ config: { fieldCode: 'gone', fieldCodes: '["price","gone2"]', viewIds: '["999"]' } });
  const ctl = b.RC.mount(b.root, {
    pluginId: 'pid',
    errorEl: b.errorEl,
    items: [
      { type: 'field', key: 'fieldCode', label: '欄', required: true },
      { type: 'fields', key: 'fieldCodes', label: '欄たち', min: 1 },
      { type: 'views', key: 'viewIds', label: '一覧' },
    ],
  });
  await ctl.ready;
  assert.ok(optTexts(b.root.byTag('select')[0]).includes('(見つかりません: gone)'));
  assert.equal(b.root.byTag('select')[0].value, 'gone');
  assert.ok(b.root.byTag('label').some((l) => l.textContent === '(見つかりません: gone2)'));
  assert.ok(b.root.byTag('label').some((l) => l.textContent === '(見つかりません: 999)'));
  assert.equal(ctl.save(), false);
  assert.equal(b.saved.length, 0);
  assert.match(b.errorEl.textContent, /gone/);
});

test('relay-config: rows(行の追加・削除・最低 1 行・行ごとの値)', async () => {
  const b = boot({ config: { rows: JSON.stringify([{ code: 'price', label: 'A' }]) } });
  const ctl = b.RC.mount(b.root, {
    pluginId: 'pid',
    errorEl: b.errorEl,
    items: [
      {
        type: 'rows',
        key: 'rows',
        label: '対応表',
        columns: [
          { type: 'field', key: 'code', label: '欄', required: true },
          { type: 'text', key: 'label', label: '表示名', required: true },
        ],
      },
    ],
  });
  await ctl.ready;
  const trs = () => b.root.byTag('tbody')[0].children;
  assert.equal(trs().length, 1);
  const rm = () => b.root.byClass('kintoneplugin-button-remove-row-image');
  rm()[0].fire('click');
  assert.equal(trs().length, 1, '最低 1 行');
  b.root.byClass('kintoneplugin-button-add-row-image')[0].fire('click');
  assert.equal(trs().length, 2);
  assert.equal(ctl.save(), false, '2 行目が空');
  const sel = b.root.byTag('select')[1];
  sel.value = 'total';
  b.root.byTag('input').filter((i) => i.className === 'kintoneplugin-input-text')[1].value = 'B';
  assert.equal(ctl.save(), true);
  const rows = JSON.parse(b.saved[0].rows);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, 'price');
  assert.equal(rows[1].code, 'total');
  assert.equal(rows[1].label, 'B');
  deq(JSON.parse(rows[1].code__labels), { total: '合計' });
});

test('relay-config: フォームが取れない時は errorEl に理由・保存しない', async () => {
  const b = boot({ fail: 'CB_NO02' });
  const ctl = b.RC.mount(b.root, { pluginId: 'pid', errorEl: b.errorEl, items: [{ type: 'field', key: 'f', label: 'x' }] });
  await ctl.ready;
  assert.match(b.errorEl.textContent, /フィールド一覧を取得できませんでした.*CB_NO02/);
  assert.equal(ctl.save(), false);
  assert.equal(b.saved.length, 0);
});

test('relay-config.js: 値を console に出さず、内部 DOM に触らない', () => {
  const src = readFileSync(join(ASSETS, 'relay-config.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/console\./.test(src));
  assert.ok(!/querySelector|innerHTML|outerHTML/.test(src));
  assert.ok(!/(box-shadow|border-radius|#[0-9a-f]{3,6}\b)/i.test(src));
});
