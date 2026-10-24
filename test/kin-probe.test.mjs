// tools/kin-probe.mjs のテスト。node:http のモック kintone サイトを立てて、
// CLI を子プロセスで実行し、JSON 出力を検証する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyNativeLibs, findExecutable, ignoreReason } from '../tools/kin-probe.mjs';
import { createProbeSite } from './fixtures/probe-site/server.mjs';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// 実ブラウザが要るテストは、chromium が無い機械では skip(この mod は自分で install しない)
const BROWSER = process.env.RELAY_CHROMIUM || (() => { try { return chromium.executablePath(); } catch { return ''; } })();
const NEEDS_BROWSER = existsSync(BROWSER) ? {} : { skip: 'chromium が無い(RELAY_CHROMIUM か npx playwright install chromium)' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(HERE, '..', 'tools', 'kin-probe.mjs');

const USERNAME = 'kinprobe-admin';
const PASSWORD = `kp-secret-${Math.random().toString(36).slice(2)}`;
const APP_ID = '7';
const PLUGIN_ID = '99';
const EMPTY_APP_ID = '8';

let site;
let baseUrl;
const tmpDirs = [];

before(async () => {
  site = createProbeSite({ username: USERNAME, password: PASSWORD, appId: APP_ID, emptyRecordsAppId: EMPTY_APP_ID });
  baseUrl = await site.listen();
});

after(async () => {
  await site.close();
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // 掃除失敗は無視
    }
  }
});

function writeEnvFile({ url = baseUrl, user = USERNAME, pass = PASSWORD, prod = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kin-probe-env-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'kintone.env');
  writeFileSync(file, `KINTONE_BASE_URL=${url}\nKINTONE_USERNAME=${user}\nKINTONE_PASSWORD=${pass}\n${prod ? 'KINTONE_PROD_HOST=127.0.0.1\nKINTONE_PROD_APPS=7\n' : ''}`, 'utf8');
  chmodSync(file, 0o600);
  return file;
}

function runCli(args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, KIN_ALLOW_LOCAL: '1', ...envOverrides },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`kin-probe.mjs timed out. stdout=${stdout} stderr=${stderr}`));
    }, 60000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseJsonLine(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

test('通常実行: ログイン・detail のエラー検出・index はクリーン・events・ok・summary', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const { code, stdout, stderr } = await runCli([APP_ID, '--wait', '150'], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0, `exit code should be 0. stderr=${stderr}`);

  const out = parseJsonLine(stdout);
  assert.equal(out.appId, APP_ID);
  assert.equal(out.ok, false, 'detail にエラーがあるので ok=false');
  assert.equal(out.pages.length, 2, 'config は開かず detail,index の2画面');

  const detail = out.pages.find((p) => p.name === 'detail');
  const index = out.pages.find((p) => p.name === 'index');
  assert.ok(detail, 'detail ページが結果に含まれる');
  assert.ok(index, 'index ページが結果に含まれる');
  assert.ok(!detail.skipped, 'レコードが取れているので detail は skip されない');

  // consoleErrors(ブラウザ自身が出す「404 を読み込めなかった」ログも1件混ざる)
  assert.ok(detail.consoleErrors.length >= 1);
  const customizeConsoleError = detail.consoleErrors.find((e) => /customize/.test(e.text));
  assert.ok(customizeConsoleError, 'customize.js からの console.error が含まれる');

  // pageErrors
  assert.equal(detail.pageErrors.length, 1);
  assert.match(detail.pageErrors[0].message, /TypeError/);
  assert.match(detail.pageErrors[0].message, /is undefined/);
  assert.match(detail.pageErrors[0].at, /customize\.js:\d+/);

  // failedRequests (missing.css, same-origin stylesheet)
  assert.equal(detail.failedRequests.length, 1);
  assert.equal(detail.failedRequests[0].status, 404);
  assert.match(detail.failedRequests[0].url, /missing\.css$/);

  // 除外リスト: favicon の 404 は consoleErrors から外れて ignored に入る。missing.css の 404 は残る
  assert.ok(!detail.consoleErrors.some((e) => /favicon/.test(e.location) || e.resourcePath === '/favicon.ico'), 'favicon は consoleErrors に残らない');
  assert.equal(detail.ignored.length, 1);
  assert.equal(detail.ignored[0].path, '/favicon.ico');
  assert.ok(detail.ignored[0].reason);
  const missingCssConsole = detail.consoleErrors.find((e) => /Failed to load resource/.test(e.text));
  assert.ok(missingCssConsole, '除外に合わない 404 は consoleErrors に残る');
  assert.equal(missingCssConsole.resourcePath, '/static/missing.css', '出どころのパスが添えられる');
  assert.deepEqual(index.ignored, []);

  // events の type と順番(無害なイベント→エラーを起こすイベントの順)
  assert.deepEqual(detail.eventOrder, ['app.record.detail.process.proceed', 'app.record.detail.show']);
  const detailCounts = Object.fromEntries(detail.events.map((e) => [e.type, e.count]));
  assert.equal(detailCounts['app.record.detail.process.proceed'], 1);
  assert.equal(detailCounts['app.record.detail.show'], 1);

  // index はエラー0
  assert.equal(index.consoleErrors.length, 0);
  assert.equal(index.pageErrors.length, 0);
  assert.equal(index.failedRequests.length, 0);
  assert.deepEqual(index.eventOrder, ['app.record.index.show']);

  // summary の形
  assert.match(out.summary, /^mod からの報告: 詳細 /);
  assert.match(out.summary, /TypeError/);
  assert.match(out.summary, /customize\.js:\d+/);
  assert.match(out.summary, /events detail\.proceed×1 detail\.show×1 index\.show×1/);
  assert.ok(out.summary.length <= 300);

  // パスワードが出力に出ていないこと
  assert.doesNotMatch(stdout + stderr, new RegExp(PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('--plugin 無しなら config は開かない(--pages に含めても無視)', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const { code, stdout } = await runCli([APP_ID, '--pages', 'config,detail,index', '--wait', '150'], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0);
  const out = parseJsonLine(stdout);
  const names = out.pages.map((p) => p.name);
  assert.ok(!names.includes('config'), 'config は開かれない');
  assert.deepEqual(names, ['detail', 'index']);
});

test('--plugin ありなら config を開く', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const { code, stdout } = await runCli([APP_ID, '--plugin', PLUGIN_ID, '--pages', 'config', '--wait', '100'], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0);
  const out = parseJsonLine(stdout);
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].name, 'config');
  assert.ok(!out.pages[0].skipped);
  assert.equal(out.pages[0].consoleErrors.length, 0);
  assert.equal(out.pages[0].pageErrors.length, 0);
  assert.equal(out.ok, true);
});

test('レコードが0件なら detail は skipped', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const { code, stdout } = await runCli([EMPTY_APP_ID, '--pages', 'detail', '--wait', '100'], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0);
  const out = parseJsonLine(stdout);
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].name, 'detail');
  assert.equal(out.pages[0].skipped, true);
  assert.equal(out.ok, true);
});

test('ログイン失敗(パスワード違い)は ok:true skipped login、パスワード文字列は出力に含まれない', NEEDS_BROWSER, async () => {
  const wrongPassword = 'totally-wrong-password-xyz';
  const envFile = writeEnvFile({ pass: wrongPassword });
  const { code, stdout, stderr } = await runCli([APP_ID, '--wait', '100'], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0, `exit 0。stderr=${stderr}`);

  const out = parseJsonLine(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
  assert.equal(out.skipCode, 'login');
  assert.equal(out.reason, 'ログインできませんでした(SSO・2要素・パスワードの可能性)');
  assert.deepEqual(out.pages, []);
  assert.equal(out.summary, 'mod からの報告: 画面チェックは省略(ログインできませんでした(SSO・2要素・パスワードの可能性)・反映は済)');

  const combined = stdout + stderr;
  assert.doesNotMatch(combined, new RegExp(wrongPassword));
  assert.doesNotMatch(combined, new RegExp(PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('RELAY_CHROMIUM が存在しない → ok:true skipped no-browser(ネットワーク不要)', async () => {
  const envFile = writeEnvFile();
  const { code, stdout } = await runCli([APP_ID], { KIN_ENV_FILE: envFile, RELAY_CHROMIUM: '/nonexistent/relay-test/chrome' });
  assert.equal(code, 0);
  const out = parseJsonLine(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
  assert.equal(out.skipCode, 'no-browser');
  assert.equal(out.reason, '画面チェック用の chromium がありません(/kin doctor を参照)');
  assert.equal(out.summary, 'mod からの報告: 画面チェックは省略(画面チェック用の chromium がありません(/kin doctor を参照)・反映は済)');
});

test('ignoreReason: favicon だけ合い、プラグインのファイルや /k/api/js/ は合わない', () => {
  assert.ok(ignoreReason('/favicon.ico'));
  assert.equal(ignoreReason('/k/api/js/abc/plugin.js'), null);
  assert.equal(ignoreReason('/k/api/plugin/file.json'), null);
  assert.equal(ignoreReason('/static/missing.css'), null);
  assert.equal(ignoreReason('/x/favicon.ico'), null);
});

test('RELAY_NATIVE_LIBS は設定時だけ LD_LIBRARY_PATH の先頭に足される', () => {
  const unset = { LD_LIBRARY_PATH: '/a' };
  applyNativeLibs(unset);
  assert.equal(unset.LD_LIBRARY_PATH, '/a');

  const set = { RELAY_NATIVE_LIBS: '/x/libs', LD_LIBRARY_PATH: '/a' };
  applyNativeLibs(set);
  assert.equal(set.LD_LIBRARY_PATH, '/x/libs:/a');

  const bare = { RELAY_NATIVE_LIBS: '/x/libs' };
  applyNativeLibs(bare);
  assert.equal(bare.LD_LIBRARY_PATH, '/x/libs');

  assert.equal(findExecutable({}), undefined);
  assert.equal(findExecutable({ RELAY_CHROMIUM: '/y/chrome' }), '/y/chrome');
});

test('env 無しで missing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kin-probe-noenv-'));
  tmpDirs.push(dir);
  const missingFile = path.join(dir, 'does-not-exist.env');
  const { code, stdout } = await runCli([APP_ID], { KIN_ENV_FILE: missingFile });
  assert.equal(code, 2);
  const out = parseJsonLine(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'missing');
});

test('--sheet: plugin があれば 設定|詳細 の2コマを横並びにした PNG(幅1080以下)を書き、sheetPages が出る', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const dir = mkdtempSync(path.join(tmpdir(), 'kin-probe-sheet-'));
  tmpDirs.push(dir);
  const sheetPath = path.join(dir, 'sub', 'sheet.png');
  const { code, stdout, stderr } = await runCli([APP_ID, '--plugin', PLUGIN_ID, '--wait', '150', '--sheet', sheetPath], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0, `stderr=${stderr}`);
  const out = parseJsonLine(stdout);
  assert.equal(out.sheet, sheetPath);
  assert.ok(existsSync(out.sheet), 'sheet の PNG が存在する');
  const buf = readFileSync(out.sheet);
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  const width = buf.readUInt32BE(16); // IHDR の width
  assert.ok(width > 0 && width <= 1080, `幅 ${width}`);
  assert.equal(out.sheetError, undefined);
  assert.deepEqual(out.sheetPages, ['config', 'detail']);
  assert.doesNotMatch(stdout + stderr, new RegExp(PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ---- v0.8: --actions / sheet / loads / events.handlers ----------------------

function writeActions(steps) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kin-probe-act-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'actions.json');
  writeFileSync(file, JSON.stringify(steps), 'utf8');
  return file;
}

function sheetTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kin-probe-sheet-'));
  tmpDirs.push(dir);
  return path.join(dir, 'sheet.png');
}

function pngWidth(file) {
  return readFileSync(file).readUInt32BE(16);
}

test('通常実行: detail に recordId と loads、events に handlers、config に screen(項目名と buttons)', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const { code, stdout } = await runCli([APP_ID, '--plugin', PLUGIN_ID, '--wait', '150'], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0);
  const out = parseJsonLine(stdout);
  const detail = out.pages.find((p) => p.name === 'detail');
  const config = out.pages.find((p) => p.name === 'config');
  assert.equal(detail.recordId, '42');
  assert.equal(detail.loads, 1);
  const show = detail.events.find((e) => e.type === 'app.record.detail.show');
  assert.deepEqual(show, { type: 'app.record.detail.show', count: 1, handlers: 1 });
  assert.ok(config.screen.labels.includes('対象フィールド'), JSON.stringify(config.screen));
  assert.ok(config.screen.buttons.includes('保存'));
  assert.equal(config.loads, 1);
});

test('--actions: 開く→入力(label / xpath フォールバック)→選択→ダイアログ→保存→遷移後の recordId・sheet 2コマ', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const sheet = sheetTmp();
  const actions = writeActions([
    { open: 'create' },
    { expect: { text: 'レコードの追加' } },
    { fill: { label: '品番', value: 'ZZ-999' } },
    { expect: { text: '未登録' } },
    { fill: { label: '数量', value: '5' } },
    { select: { label: '区分', value: 'RM-401' } },
    { click: 'text=削除' },
    { click: { role: 'button', name: 'キャンセル' } },
    { save: true },
    { read: true },
  ]);
  const before = site.saved.length;
  const { code, stdout, stderr } = await runCli([APP_ID, '--actions', actions, '--pages', 'config', '--wait', '150', '--sheet', sheet], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0, stderr);
  const out = parseJsonLine(stdout);
  assert.equal(out.ok, true, stdout);
  assert.equal(out.pages.length, 1, '--pages は無視して1枚のページ');
  assert.equal(out.pages[0].name, 'actions');
  assert.equal(out.actions.length, 10);
  assert.ok(out.actions.every((a) => a.ok), JSON.stringify(out.actions));
  assert.deepEqual(out.actions.map((a) => a.kind), ['open', 'expect', 'fill', 'expect', 'fill', 'select', 'click', 'click', 'save', 'read']);
  assert.match(out.actions[6].text, /本当に削除しますか/, 'click の後はダイアログ本文');
  assert.equal(out.actions[8].recordId, '43', '保存後の URL から recordId');
  assert.match(out.actions[9].text, /保存しました/);
  assert.equal(out.opened.recordId, '43');
  assert.equal(out.opened.page, 'detail');
  assert.match(out.opened.url, /\/done#record=43$/);
  assert.match(out.screen.text, /保存しました/);
  assert.deepEqual(Object.keys(out.screen).sort(), ['buttons', 'labels', 'text']);
  assert.deepEqual(site.saved.slice(before), [{ part: 'ZZ-999', qty: '5', kind: 'RM-401' }]);
  // 2 つの document を渡り歩いた: loads、events(同じ type に2つ登録 → handlers:2、1回の発火で count:2)
  assert.ok(out.pages[0].loads >= 2);
  const create = out.pages[0].events.find((e) => e.type === 'app.record.create.show');
  assert.deepEqual(create, { type: 'app.record.create.show', count: 2, handlers: 2 });
  // sheet: 直前|最後 の2コマ・横 1080px 以下
  assert.equal(out.sheet, sheet);
  assert.deepEqual(out.sheetPages, ['before', 'last']);
  const w = pngWidth(sheet);
  assert.ok(w > 0 && w <= 1080, `幅 ${w}`);
  assert.doesNotMatch(stdout + stderr, new RegExp(PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('--actions: モーダルの後ろに同じ文字があってもモーダル側を押す・ラベルの無い選択欄を選択肢の文字(部分一致)で選ぶ', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const actions = writeActions([
    { open: 'create' },
    { click: 'text=マスターを整える' },
    { click: 'text=TEST-V08' },
    { select: { value: 'RM-401' } },
    { expect: { text: '統合先: rm401' } },
    { fill: { label: '品番*', value: 'X' } }, // 末尾の必須の印は外して探す
  ]);
  const { code, stdout, stderr } = await runCli([APP_ID, '--actions', actions, '--wait', '150'], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0, stdout + stderr);
  const out = parseJsonLine(stdout);
  assert.deepEqual(out.actions.map((a) => a.ok), [true, true, true, true, true, true], JSON.stringify(out.actions) + stderr);
});

test('--actions: 画面の確認 screen にダイアログ本文・buttons・labels が出る', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const actions = writeActions([{ open: 'create' }, { click: 'text=削除' }]);
  const { stdout } = await runCli([APP_ID, '--actions', actions, '--wait', '100'], { KIN_ENV_FILE: envFile });
  const out = parseJsonLine(stdout);
  assert.equal(out.ok, true, stdout);
  assert.match(out.screen.dialog, /本当に削除しますか/);
  assert.ok(out.screen.buttons.includes('保存') && out.screen.buttons.includes('はい'));
  assert.ok(out.screen.labels.includes('品番') && out.screen.labels.includes('数量') && out.screen.labels.includes('区分'), JSON.stringify(out.screen.labels));
});

test('--actions: 手順が失敗したらそこで止まり、残りは skipped。sheet も返る', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const sheet = sheetTmp();
  const actions = writeActions([
    { open: 'create' },
    { fill: { label: '存在しない項目', value: 'x' } },
    { save: true },
    { read: true },
  ]);
  const before = site.saved.length;
  const { code, stdout } = await runCli([APP_ID, '--actions', actions, '--wait', '100', '--sheet', sheet], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0);
  const out = parseJsonLine(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.actions[0].ok, true);
  assert.equal(out.actions[1].ok, false);
  assert.match(out.actions[1].error, /存在しない項目/);
  assert.equal(out.actions[2].skipped, true);
  assert.equal(out.actions[3].skipped, true);
  assert.match(out.summary, /手順 2\/4\(fill\)で失敗/);
  assert.equal(site.saved.length, before, '失敗後は保存しない');
  assert.equal(out.sheet, sheet);
  assert.ok(existsSync(sheet));
  assert.deepEqual(out.sheetPages, ['last'], 'click/save の直前が無ければ最後の1コマ');
});

test('--actions: expect が見えなければ失敗(timeout 指定)', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const actions = writeActions([{ open: 'create' }, { expect: { text: '絶対に出ない文字', timeout: 300 } }, { read: true }]);
  const { stdout } = await runCli([APP_ID, '--actions', actions, '--wait', '100'], { KIN_ENV_FILE: envFile });
  const out = parseJsonLine(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.actions[1].ok, false);
  assert.equal(out.actions[2].skipped, true);
});

test('--actions: 不正な手順は bad_input(CSS セレクタ・31手順・wait 超過・config に plugin 無し)でブラウザは起こさない', async () => {
  const envFile = writeEnvFile();
  // chromium が無くても bad_input が返る(検証が先)
  const env = { KIN_ENV_FILE: envFile, RELAY_CHROMIUM: '/nonexistent/relay-test/chrome' };
  const cases = [
    [{ open: 'create' }, { click: '.save-button' }],
    [{ open: 'create' }, { click: '#save' }],
    [{ click: { role: 'button; x', name: 'a' } }],
    Array.from({ length: 31 }, () => ({ read: true })),
    [{ wait: 20000 }],
    [{ open: 'config' }],
    [{ fill: { label: '', value: 'x' } }],
    [{ foo: 1 }],
  ];
  for (const c of cases) {
    const { code, stdout } = await runCli([APP_ID, '--actions', writeActions(c), '--sheet', sheetTmp()], env);
    const out = parseJsonLine(stdout);
    assert.equal(out.ok, false, JSON.stringify(c).slice(0, 80));
    assert.equal(out.error.code, 'bad_input', stdout);
    assert.equal(out.sheet, null, 'bad_input でも --sheet なら sheet:null');
    assert.ok(out.sheetError);
    assert.equal(code, 1);
  }
});

test('本番では fill/select/press/save/click を含む手順は prod_denied(ブラウザを起こさない)', async () => {
  const envFile = writeEnvFile({ prod: true });
  const env = { KIN_ENV_FILE: envFile, RELAY_CHROMIUM: '/nonexistent/relay-test/chrome' }; // 起こせば no-browser になる
  for (const step of [{ fill: { label: '品番', value: 'x' } }, { select: { label: '区分', value: 'a' } }, { press: 'Enter' }, { save: true }, { click: 'text=保存' }]) {
    const { stdout } = await runCli([APP_ID, '--actions', writeActions([{ open: 'create' }, step]), '--sheet', sheetTmp()], env);
    const out = parseJsonLine(stdout);
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'prod_denied', stdout);
    assert.match(out.error.message, /本番では.*できません\(開発環境だけ\)/);
    assert.equal(out.sheet, null);
    assert.ok(out.sheetError);
  }
});

test('本番でも open/expect/wait/read だけの手順は可', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile({ prod: true });
  const actions = writeActions([{ open: 'create' }, { expect: { text: 'レコードの追加' } }, { wait: 50 }, { read: true }]);
  const { stdout } = await runCli([APP_ID, '--actions', actions, '--wait', '100'], { KIN_ENV_FILE: envFile });
  const out = parseJsonLine(stdout);
  assert.equal(out.ok, true, stdout);
  assert.equal(out.actions.length, 4);
});

test('--sheet は skipped(ログイン失敗・chromium 無し)でも sheet:null と sheetError を返す', async () => {
  const sheet = sheetTmp();
  // chromium 無し
  let r = await runCli([APP_ID, '--sheet', sheet], { KIN_ENV_FILE: writeEnvFile(), RELAY_CHROMIUM: '/nonexistent/relay-test/chrome' });
  let out = parseJsonLine(r.stdout);
  assert.equal(out.skipCode, 'no-browser');
  assert.equal(out.sheet, null);
  assert.ok(out.sheetError);
  assert.ok(!existsSync(sheet));
  // --sheet 無しなら sheet は出ない
  r = await runCli([APP_ID], { KIN_ENV_FILE: writeEnvFile(), RELAY_CHROMIUM: '/nonexistent/relay-test/chrome' });
  out = parseJsonLine(r.stdout);
  assert.equal('sheet' in out, false);
});

test('--sheet はログイン失敗の skipped でも sheet:null と sheetError(--actions の手順は skipped)', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile({ pass: 'wrong-password-zzz' });
  const actions = writeActions([{ open: 'create' }, { read: true }]);
  const { stdout } = await runCli([APP_ID, '--actions', actions, '--wait', '100', '--sheet', sheetTmp()], { KIN_ENV_FILE: envFile });
  const out = parseJsonLine(stdout);
  assert.equal(out.skipCode, 'login');
  assert.equal(out.sheet, null);
  assert.ok(out.sheetError);
  assert.deepEqual(out.actions.map((a) => a.skipped), [true, true]);
});

test('--sheet は途中で例外(env 無し)になっても sheet:null と sheetError を返す', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kin-probe-noenv-'));
  tmpDirs.push(dir);
  const { stdout } = await runCli([APP_ID, '--sheet', sheetTmp()], { KIN_ENV_FILE: path.join(dir, 'nope.env') });
  const out = parseJsonLine(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.sheet, null);
  assert.ok(out.sheetError);
});

test('--sheet: plugin 無しなら 詳細|一覧、--pages が3つでも最大2コマ(横1080px以下)', NEEDS_BROWSER, async () => {
  const sheet = sheetTmp();
  const { stdout } = await runCli([APP_ID, '--pages', 'config,detail,index', '--wait', '100', '--sheet', sheet], { KIN_ENV_FILE: writeEnvFile() });
  const out = parseJsonLine(stdout);
  assert.deepEqual(out.sheetPages, ['detail', 'index']);
  assert.ok(pngWidth(sheet) <= 1080);
});

// ---- v1.0: --thumbs ----------------------------------------------------------

test('--thumbs: 開いた画面ごとに 540px 幅以下の JPEG を書き、thumbs に page/path/width/height/chars が出る(Svg 上限に収まる)', NEEDS_BROWSER, async () => {
  const envFile = writeEnvFile();
  const dir = mkdtempSync(path.join(tmpdir(), 'kin-probe-thumbs-'));
  tmpDirs.push(dir);
  const outDir = path.join(dir, 'sub');
  const { code, stdout, stderr } = await runCli([APP_ID, '--pages', 'index,detail', '--wait', '150', '--thumbs', outDir], { KIN_ENV_FILE: envFile });
  assert.equal(code, 0, `stderr=${stderr}`);
  const out = parseJsonLine(stdout);
  assert.equal(out.thumbsError, undefined);
  assert.deepEqual(out.thumbs.map((t) => t.page).sort(), ['detail', 'index']);
  for (const t of out.thumbs) {
    const buf = readFileSync(t.path);
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8); // JPEG
    assert.ok(t.width > 0 && t.width <= 540, `幅 ${t.width}`);
    assert.ok(t.height > 0);
    assert.equal(t.chars, buf.toString('base64').length);
    assert.ok(t.chars + 300 <= 131072);
  }
  assert.ok(out.pages.every((p) => typeof p.url === 'string' && p.url));
});

test('--thumbs は chromium 無し(skipped)でも thumbs:[] と thumbsError を返す', async () => {
  const envFile = writeEnvFile();
  const { stdout } = await runCli([APP_ID, '--thumbs', path.join(tmpdir(), 'kin-probe-thumbs-none')], { KIN_ENV_FILE: envFile, RELAY_CHROMIUM: '/nonexistent/chromium' });
  const out = parseJsonLine(stdout);
  assert.equal(out.skipCode, 'no-browser');
  assert.deepEqual(out.thumbs, []);
  assert.ok(out.thumbsError);
});
