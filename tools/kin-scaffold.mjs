#!/usr/bin/env node
// kin-scaffold: kintone プラグインのひな形を plugins/<name>/ に作る(v0.3 から)。
// 使い方:
//   node tools/kin-scaffold.mjs <name> <event|config-only|header-button|index-band|detail-notice> [--root <dir>] [--app <appId>]
//                               [--title <日本語名>] [--fields-json <file>] [--brand <提供者名>]
//   kind: event=保存/表示イベント / config-only=設定だけ / header-button=一覧ヘッダーのボタン+パネル /
//         index-band=一覧の集計帯 / detail-notice=詳細の未入力注意
// 同梱: 51-modern-default.css(kintone 公式・MIT)と relay-ui.js を tools/assets/ から写す
// 出力は 1 行 JSON: {ok:true, dir, files, pluginIdHint:null} / {ok:false, error:{code,message}}
// 秘密鍵(.keys/<name>.ppk)の中身は表示しない。
// 家の決まりの出どころ:
//   - 画面にブランドを出さない・kintone標準の見た目: memory plugbits-no-brand-in-ui
//   - kintone 内部 DOM に触らない(公式 API とイベントだけ): memory plugbits-dom-rule
//   - manifest の形・config の getConfig/setConfig: ~/repos/plugbits-plugins/plugins/_template, kintone-inspection

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export class ScaffoldError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const KINDS = ['event', 'config-only', 'header-button', 'index-band', 'detail-notice'];
const ASSETS = ['51-modern-default.css', 'relay-ui.js', 'relay-config.js'];
const assetPath = (f) => new URL(`./assets/${f}`, import.meta.url);

// ---- icon.png: 56x56 単色の最小 PNG をコードで作る ----
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function makePng(size = 56, rgb = [0x34, 0x98, 0xdb]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ppk: plugin-packer(node-rsa) が読む PKCS#1 PEM。packer の exportKey("pkcs1-private") と同形式 ----
export function generatePpk() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return privateKey;
}

// ---- テンプレート ----
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function manifest(name, title, kind) {
  const m = {
    manifest_version: 1,
    version: 1,
    type: 'APP',
    name: { ja: title, en: name },
    description: {
      ja: `${title}(TODO: 説明を書く)`,
      en: `${name} (TODO: write a description)`,
    },
    icon: 'icon.png',
    desktop: { js: ['relay-ui.js', 'desktop.js'], css: ['51-modern-default.css'] },
    mobile: { js: ['relay-ui.js', 'mobile.js'], css: ['51-modern-default.css'] },
    config: {
      html: 'config.html',
      js: ['relay-config.js', 'config.js'],
      css: ['51-modern-default.css', 'config.css'],
      required_params: KIND_SPECS[kind].required,
    },
  };
  return JSON.stringify(m, null, 2) + '\n';
}

function fieldsComment(fields) {
  if (!fields) return '';
  const lines = [];
  for (const f of fields) {
    lines.push(` *   ${f.code}  ${f.label}  [${f.type}]`);
    for (const s of f.subtable || []) lines.push(` *     - ${s.code}  ${s.label}  [${s.type}]`);
  }
  return `/*\n * 対象アプリのフィールド(kin-loop form の出力。参考用・ここから直書きしない。設定画面のドロップダウンで選ばせる)\n${lines.join('\n')}\n */\n`;
}

const RULES = `// ---- このプラグインの決まり(Claude は編集時もこれを守ること) ----
// 1. kintone の内部 DOM に触らない。使ってよいのは公式 API とイベントだけ
//    (kintone.events / kintone.app.record.* / kintone.app.getHeaderMenuSpaceElement /
//     kintone.app.record.getSpaceElement / kintone.plugin.app.* / kintone.api)。
//    querySelector で kintone 側の要素を探す・クラス名に依存する、は禁止。
// 2. 色は kintone 標準だけ。独自のブランド色・ロゴ・ワードマークを画面に出さない。
//    入口ボタンは機能名。提供者名(--brand で作った時だけ)は設定画面の最下段の小さな提供行だけ。
// 3. 'use strict' の即時関数で包み、プラグイン ID は kintone.$PLUGIN_ID を使う。
// 4. 見た目: 設定画面は 51-modern-default の kintoneplugin-* クラスだけで組む。本体は relay-ui の部品
//    (headerButton・band・notice・panel)を使い、独自 CSS で色・影・角丸を足さない。文言は機能名。
//    エラーと注意は kintoneplugin-alert。
`;

function eventJs(kind, fields, isMobile, title) {
  if (kind === 'header-button' || kind === 'index-band' || kind === 'detail-notice') return uiJs(kind, fields, isMobile, title);
  const cfgRead = `  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const config = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
  const fieldCode = config.fieldCode || '';
`;
  if (kind === 'config-only') {
    return `${isMobile ? '' : fieldsComment(fields)}${RULES}
(function () {
  'use strict';
${cfgRead}
  // TODO: 設定(fieldCode)を使う処理をここに書く。いまは読むだけ。
  void fieldCode;
})();
`;
  }
  const events = ['create.submit', 'edit.submit', 'detail.show', 'index.show'];
  const blocks = events
    .map((t) => {
      const full = isMobile ? `mobile.app.record.${t}` : `app.record.${t}`;
      const isSubmit = t.endsWith('.submit');
      const doc = isSubmit
        ? '保存前に呼ばれる。エラーにするなら event.error = \'...\'、止めずに通すなら event を返す。'
        : '画面表示のたびに呼ばれる。';
      return `  // ${doc}
  kintone.events.on('${full}', function (event) {
    // TODO: ${t} の処理を書く(fieldCode = ${'${fieldCode}'} の値は event.record[fieldCode] で読める)
    return event;
  });
`;
    })
    .join('\n');
  return `${isMobile ? '' : fieldsComment(fields)}${RULES}
(function () {
  'use strict';
${cfgRead}
  if (!fieldCode) return; // 設定が空なら何もしない

${blocks}})();
`;
}

// kind ごとの設定項目(RelayConfig.mount に渡す items)。部品の type は tools/assets/relay-config.js を参照
const KIND_SPECS = {
  event: {
    intro: 'レコードの保存・表示のタイミングで、選んだフィールドを使った処理を行います。',
    required: ['fieldCode'],
    items: [{ type: 'field', key: 'fieldCode', label: '対象フィールド', desc: '処理の対象にするフィールドを選びます。', required: true }],
  },
  'config-only': {
    intro: '選んだフィールドを設定として保存します。',
    required: ['fieldCode'],
    items: [{ type: 'field', key: 'fieldCode', label: '対象フィールド', desc: '設定として使うフィールドを選びます。', required: true }],
  },
  'header-button': {
    intro: '一覧画面のヘッダーにボタンを出し、押すと一覧の情報をパネルで表示します。',
    required: ['fieldCode'],
    items: [
      { type: 'field', key: 'fieldCode', label: '対象フィールド', desc: 'パネルに値を表示するフィールドを選びます。', required: true },
      { type: 'text', key: 'buttonLabel', label: 'ボタンの文字', desc: '空のときはプラグインのタイトルを使います。', maxLength: 40 },
    ],
  },
  'index-band': {
    intro: '一覧画面の上に、絞り込み後のレコードの件数と合計を表示します。',
    required: ['fieldCodes', 'viewIds'],
    items: [
      {
        type: 'fields',
        key: 'fieldCodes',
        label: '集計するフィールド',
        desc: '数値フィールドまたは計算フィールドから選びます(複数可)。',
        types: ['NUMBER', 'CALC'],
        subtable: false,
        min: 1,
        required: true,
      },
      {
        type: 'views',
        key: 'viewIds',
        label: '帯を出す一覧',
        desc: '「すべての一覧」を選ぶと、どの一覧でも表示します。',
        min: 1,
        required: true,
        default: ['__all__'],
      },
    ],
  },
  'detail-notice': {
    intro: '詳細画面で、選んだフィールドが未入力のときに注意を表示します。',
    required: ['fieldCodes'],
    items: [
      { type: 'fields', key: 'fieldCodes', label: '確かめるフィールド', desc: '未入力かどうかを確かめるフィールドを選びます(複数可)。', min: 1, required: true },
      { type: 'text', key: 'noticeText', label: '注意の文', desc: '空のときは「<フィールド名>が未入力です」と表示します。', maxLength: 200 },
    ],
  },
};

function configHtml(title, brand, kind) {
  const spec = KIND_SPECS[kind];
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body>
  <div class="relay-config">
    <div class="kintoneplugin-row">
      <div class="kintoneplugin-desc">${esc(spec.intro)}</div>
    </div>
    <div id="settings"></div>
    <div class="kintoneplugin-alert" id="error" hidden></div>
    <div class="relay-config-buttons">
      <button id="cancel" type="button" class="kintoneplugin-button-dialog-cancel">キャンセル</button>
      <button id="save" type="button" class="kintoneplugin-button-dialog-ok">保存</button>
    </div>
${brand ? `    <div class="relay-brand"><small>提供: ${esc(brand)}</small></div>
` : ''}  </div>
</body>
</html>
`;
}

// 配置だけ。色・影・角丸・フォントは 51-modern-default.css(kintone 標準)に任せる
const CONFIG_CSS = `.relay-config { padding: 24px 24px 48px; max-width: 720px; }
.relay-config .kintoneplugin-row { margin-bottom: 24px; }
.relay-config .kintoneplugin-alert[hidden] { display: none; }
.relay-config-buttons { margin-top: 32px; text-align: right; }
.relay-config-buttons button { margin-left: 12px; }
.relay-brand { margin-top: 48px; text-align: right; }
`;

// config.js は部品(relay-config.js)に項目を渡すだけ。選択肢は実行時に公式 API で取る
function configJs(kind, hasFields) {
  const items = JSON.stringify(KIND_SPECS[kind].items, null, 2).replace(/\n/g, '\n    ');
  return `${RULES}
(function () {
  'use strict';
  // 設定項目(setConfig の値は全部文字列)。部品の使い方は relay-config.js の先頭コメント。
  // ${hasFields ? 'desktop.js 冒頭のコメントは参考用。ここでは実行時に同じ API で取り直す。' : 'フィールドコードは直書きせず、ドロップダウンで選ばせる。'}
  const ctl = RelayConfig.mount(document.getElementById('settings'), {
    pluginId: kintone.$PLUGIN_ID,
    items: ${items},
    errorEl: document.getElementById('error'),
  });
  document.getElementById('save').addEventListener('click', function () {
    ctl.save(); // 検証 → setConfig(コールバック省略時は kintone がプラグイン一覧へ戻す)
  });
  document.getElementById('cancel').addEventListener('click', function () {
    ctl.cancel(); // /k/admin/app/<id>/plugin/ へ
  });
})();
`;
}

// ---- 本体(relay-ui の部品を使う kind)----
const UI_HELPERS = `  function show(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(show).join(', ');
    if (typeof v === 'object') return v.name || v.code || '';
    return String(v);
  }
`;

function uiJs(kind, fields, isMobile, title) {
  const pre = isMobile ? 'mobile.' : '';
  const mob = isMobile ? ', mobile: true' : '';
  const top = `${isMobile ? '' : fieldsComment(fields)}${RULES}
(function () {
  'use strict';
  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const config = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
`;
  // 設定の JSON 文字列は壊れていても落とさない(読めなければ空)。旧キー(fieldCode 1つ)の設定も読む
  const listHelpers = `
  function parseList(s) {
    try {
      const a = JSON.parse(s);
      return Array.isArray(a) ? a.map(String) : [];
    } catch (e) {
      return [];
    }
  }
  function parseMap(s) {
    try {
      const o = JSON.parse(s);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (e) {
      return {};
    }
  }
  const fieldCodes = config.fieldCodes ? parseList(config.fieldCodes) : config.fieldCode ? [config.fieldCode] : [];
  const labels = config.fieldCodes ? parseMap(config.fieldCodes__labels) : config.fieldCode ? { [config.fieldCode]: config.fieldLabel || config.fieldCode } : {};
  if (fieldCodes.length === 0) return; // 設定が空(または壊れている)なら何もしない
`;
  const head = `${top}  const fieldCode = config.fieldCode || '';
  if (!fieldCode) return; // 設定が空なら何もしない
`;
  if (kind === 'header-button') {
    return `${head}  const label = config.buttonLabel || ${JSON.stringify(title)};
${UI_HELPERS}
  kintone.events.on('${pre}app.record.index.show', function (event) {
    const id = 'relay-hb-' + PLUGIN_ID;
    RelayUI.headerButton({
      id: id,
      label: label,
      onClick: function () {
        const records = event.records || [];
        // TODO: パネルに出したい中身に差し替える(いまは件数と対象フィールドの先頭数件)
        const content = document.createElement('div'); // 自分の要素だけを作る
        const add = function (t) {
          const row = document.createElement('div');
          row.textContent = t;
          content.appendChild(row);
        };
        add('表示中 ' + records.length + ' 件');
        records.slice(0, 5).forEach(function (r) {
          add(show(r[fieldCode] && r[fieldCode].value));
        });
        RelayUI.togglePanel({ id: id + '-panel', title: label, content: content${mob} });
      }${mob}
    });
    return event;
  });
})();
`;
  }
  if (kind === 'index-band') {
    return `${top}  const LIMIT = 10000;
  const PAGE = 500;
${listHelpers}
  // 対象の一覧: viewIds に '__all__' があればどの一覧でも。旧設定(viewIds 無し)も全部の一覧
  const viewIds = config.viewIds ? parseList(config.viewIds) : ['__all__'];
  const allViews = viewIds.indexOf('__all__') >= 0;

  // 絞り込み条件のまま全件(上限 LIMIT 件)取って、件数と欄ごとの合計を出す
  async function collect() {
    const cond = kintone.${pre}app.getQueryCondition() || '';
    const app = kintone.${pre}app.getId();
    let n = 0;
    const sums = {};
    fieldCodes.forEach(function (c) { sums[c] = 0; });
    let capped = false;
    for (let offset = 0; ; offset += PAGE) {
      const resp = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
        app: app,
        query: cond + ' limit ' + PAGE + ' offset ' + offset,
        fields: fieldCodes,
      });
      resp.records.forEach(function (r) {
        n += 1;
        fieldCodes.forEach(function (c) {
          sums[c] += Number(r[c] && r[c].value) || 0;
        });
      });
      if (resp.records.length < PAGE) break;
      if (offset + PAGE >= LIMIT) {
        capped = true;
        break;
      }
    }
    return { n: n, sums: sums, capped: capped };
  }

  kintone.events.on('${pre}app.record.index.show', function (event) {
    const id = 'relay-band-' + PLUGIN_ID;
    if (!allViews && viewIds.indexOf(String(event.viewId)) < 0) {
      RelayUI.clearNotice(id); // 対象外の一覧では帯を出さない(自分の要素を外すだけ)
      return event;
    }
    RelayUI.band({ id: id, loading: true${mob} });
    collect()
      .then(function (r) {
        const items = [{ label: '件数', value: r.n }];
        fieldCodes.forEach(function (c) {
          items.push({ label: (labels[c] || c) + ' 合計', value: r.sums[c] });
        });
        if (r.capped) items.push({ label: '注', value: '10,000件まで' });
        RelayUI.band({ id: id, items: items${mob} });
      })
      .catch(function (e) {
        RelayUI.band({ id: id, text: '集計できませんでした: ' + (e && e.message ? e.message : e)${mob} });
      });
    return event;
  });
})();
`;
  }
  // detail-notice
  return `${top}${listHelpers}  const customText = config.noticeText || '';

  function isEmpty(v) {
    return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  }

  kintone.events.on('${pre}app.record.detail.show', function (event) {
    const id = 'relay-notice-' + PLUGIN_ID;
    // 未入力の欄をまとめて 1 つの注意にする
    const empty = fieldCodes.filter(function (c) {
      const f = event.record[c];
      return !f || isEmpty(f.value);
    });
    if (empty.length > 0) {
      const names = empty.map(function (c) { return '「' + (labels[c] || c) + '」'; }).join('');
      RelayUI.notice({ id: id, text: customText || names + 'が未入力です', tone: 'warn'${mob} });
    } else {
      RelayUI.clearNotice(id);
    }
    return event;
  });
})();
`;
}

// ---- 本体 ----
export function scaffold({ name, kind, root = process.cwd(), app, title, fieldsJson, brand } = {}) {
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    throw new ScaffoldError('bad_name', 'name は [a-z0-9-]+ で指定してください');
  }
  if (!KINDS.includes(kind)) {
    throw new ScaffoldError('bad_kind', `kind は ${KINDS.join(' / ')} のどれかです`);
  }
  let fields = null;
  if (fieldsJson) {
    try {
      const j = JSON.parse(readFileSync(resolve(fieldsJson), 'utf8'));
      fields = Array.isArray(j) ? j : j.fields;
      if (!Array.isArray(fields)) throw new Error('fields 配列が無い');
    } catch (e) {
      throw new ScaffoldError('bad_fields_json', `--fields-json を読めません: ${e.message}`);
    }
  }
  const dir = resolve(root, 'plugins', name);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new ScaffoldError('exists', `${dir} は空ではありません`);
  }
  const t = title || name;
  const out = {
    'manifest.json': manifest(name, t, kind),
    'config.html': configHtml(t, brand, kind),
    'config.css': CONFIG_CSS,
    'config.js': configJs(kind, !!fields),
    'desktop.js': eventJs(kind, fields, false, t),
    'mobile.js': eventJs(kind, fields, true, t),
    'icon.png': makePng(),
  };
  for (const f of ASSETS) out[f] = readFileSync(assetPath(f)); // そのまま写す(中身は変えない)
  const files = [];
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(out)) {
    writeFileSync(join(dir, f), body);
    files.push(f);
  }
  mkdirSync(join(dir, '.keys'), { recursive: true });
  const keyRel = join('.keys', `${name}.ppk`);
  writeFileSync(join(dir, keyRel), generatePpk(), { mode: 0o600 });
  files.push(keyRel);
  void app; // appId は将来 deploy 連携用。ひな形には埋めない
  return { ok: true, dir, files, pluginIdHint: null };
}

function parseArgs(argv) {
  const pos = [];
  const o = {};
  const flags = { '--root': 'root', '--app': 'app', '--title': 'title', '--fields-json': 'fieldsJson', '--brand': 'brand' };
  for (let i = 0; i < argv.length; i++) {
    if (flags[argv[i]]) o[flags[argv[i]]] = argv[++i];
    else pos.push(argv[i]);
  }
  return { name: pos[0], kind: pos[1], ...o };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    console.log(JSON.stringify(scaffold(parseArgs(process.argv.slice(2)))));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: { code: e.code || 'error', message: e.message } }));
    process.exitCode = 1;
  }
}
