// tools/kin-loop.mjs のテスト。node:http で 127.0.0.1 にモック kintone を立て、
// kin-loop.mjs を子プロセスとして実行して確かめる。
// 実行: node --test test/kin-loop.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync, cpSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'tools', 'kin-loop.mjs');
const FIXTURE_PLUGIN_DIR = join(__dirname, 'fixtures', 'sample-plugin');

const SECRET_PASSWORD = 'S3cr3t-P@ssw0rd-do-not-leak';
// 控え(relay-backup)は本物の ~/.config に書かず、テスト用の一時ディレクトリへ
const BACKUP_DIR = mkdtempSync(join(tmpdir(), 'kin-loop-backup-'));

// ---- モック kintone サーバー ----

function defaultState() {
  return {
    apps: [],
    formFields: { properties: {}, revision: '1' },
    appPluginsResponse: { plugins: [], revision: '1' },
    customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] }, revision: '1' },
    installed: new Set(),
    versions: {},
    deleteCalls: [],
    fileKeys: [],
    appPlugins: new Set(),
    lastQueriedPluginIds: [],
    pluginPostCalls: [],
    pluginPutCalls: [],
    appPluginsPostCalls: [],
    configShouldFail: false,
    configPutCalls: 0,
    deployPostCalls: 0,
    deployPollCount: 0,
    deploySuccessAfterPolls: 1,
    deployFinalStatus: 'SUCCESS',
    fileUploadCount: 0,
    fileUploadContentType: null,
    lastAuthHeader: null,
    fileKey: 'mock-file-key-0001',
    records: [],
    recordsTotal: null,
    recordsCalls: [],
    previewCustomize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] }, revision: '1' },
    customizePutCalls: [],
    formsByApp: {}, // 参照先アプリのフォーム({appId: {properties}})。無ければ formFields
    previewForm: { properties: {}, revision: '5' },
    previewLayout: { layout: [], revision: '5' },
    formWrites: [], // {method, path, body}
    layoutPutCalls: [],
    failFormPut: false,
    deployBodies: [],
    appPluginsByApp: null, // {appId: Set} にすると app ごとに分ける(multi deploy)
  };
}

function parseIndexedArray(searchParams, name) {
  const out = [];
  for (const [k, v] of searchParams.entries()) {
    const m = k.match(new RegExp(`^${name}\\[(\\d+)\\]$`));
    if (m) out[Number(m[1])] = v;
  }
  return out;
}

async function startMockServer(state) {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.lastAuthHeader = req.headers['x-cybozu-authorization'];
      const body = Buffer.concat(chunks);
      try {
        handle(req.method, u, body, req.headers, res, state);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'MOCK_ERROR', message: String(e) }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function send(res, status, obj) {
  const text = JSON.stringify(obj ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

function readJsonBody(body) {
  if (!body || body.length === 0) return {};
  return JSON.parse(body.toString('utf8'));
}

function handle(method, u, body, headers, res, state) {
  const path = u.pathname;
  const q = u.searchParams;

  if (path === '/k/v1/apps.json' && method === 'GET') {
    const limit = Number(q.get('limit') || 100);
    const offset = Number(q.get('offset') || 0);
    return send(res, 200, { apps: state.apps.slice(offset, offset + limit) });
  }

  if (path === '/k/v1/app/form/fields.json' && method === 'GET') {
    return send(res, 200, state.formsByApp[q.get('app')] || state.formFields);
  }

  if (path === '/k/v1/preview/app/form/fields.json') {
    if (method === 'GET') return send(res, 200, state.previewForm);
    state.formWrites.push({ method, path, body: readJsonBody(body) });
    if (state.failFormPut) return send(res, 400, { code: 'CB_VA01', id: 'mock', message: 'mock form error' });
    return send(res, 200, { revision: '6' });
  }
  if (path === '/k/v1/preview/app/form/layout.json') {
    if (method === 'GET') return send(res, 200, state.previewLayout);
    state.layoutPutCalls.push(readJsonBody(body));
    return send(res, 200, { revision: '7' });
  }

  if (path === '/k/v1/app/form/layout.json' && method === 'GET') {
    if (!state.formLayout) return send(res, 404, { code: 'GAIA_NO', message: 'no layout' });
    return send(res, 200, state.formLayout);
  }
  if (path === '/k/v1/app.json' && method === 'GET') {
    // app.json の引数は app ではなく id(kintone の仕様)
    if (!q.get('id')) return send(res, 400, { code: 'CB_VA01', message: 'id is required' });
    if (!state.appInfo) return send(res, 404, { code: 'GAIA_NO', message: 'no app' });
    return send(res, 200, state.appInfo);
  }

  if (path === '/k/v1/app/plugins.json' && method === 'GET') {
    return send(res, 200, state.appPluginsResponse);
  }

  if (path === '/k/v1/app/views.json' && method === 'GET') {
    if (!state.views) return send(res, 404, { code: 'CB_NO01', message: 'not found' });
    return send(res, 200, { views: state.views, revision: '1' });
  }
  if (path === '/k/v1/app/customize.json' && method === 'GET') {
    return send(res, 200, state.customize);
  }

  if (path === '/k/v1/records.json' && method === 'GET') {
    state.recordsCalls.push({ app: q.get('app'), query: q.get('query'), fields: parseIndexedArray(q, 'fields') });
    return send(res, 200, { records: state.records, totalCount: state.recordsTotal });
  }

  if (path === '/k/v1/preview/app/customize.json' && method === 'GET') {
    return send(res, 200, state.previewCustomize);
  }

  if (path === '/k/v1/preview/app/customize.json' && method === 'PUT') {
    state.customizePutCalls.push(readJsonBody(body));
    return send(res, 200, { revision: '9' });
  }

  if (path === '/k/v1/file.json' && method === 'POST') {
    state.fileUploadCount += 1;
    state.fileUploadContentType = headers['content-type'] || null;
    return send(res, 200, { fileKey: state.fileKey });
  }

  if (path === '/k/v1/plugins.json' && method === 'GET') {
    const ids = parseIndexedArray(q, 'ids');
    state.lastQueriedPluginIds = ids;
    const plugins = ids
      .filter((id) => state.installed.has(id))
      .map((id) => ({ id, name: 'Sample Plugin', isMarketPlugin: false, version: state.versions[id] ?? '1' }));
    return send(res, 200, { plugins });
  }

  if (path === '/k/v1/plugin.json' && method === 'POST') {
    const parsed = readJsonBody(body);
    state.pluginPostCalls.push(parsed);
    const id = state.lastQueriedPluginIds[0];
    if (id) { state.installed.add(id); state.versions[id] = '1.0.0'; }
    return send(res, 200, { id: id || 'unknown', version: '1.0.0' });
  }

  if (path === '/k/v1/plugin.json' && method === 'PUT') {
    const parsed = readJsonBody(body);
    state.pluginPutCalls.push(parsed);
    if (parsed.id) {
      state.installed.add(parsed.id);
      const n = Number((state.versions[parsed.id] || '1.0.0').split('.')[2]) + 1;
      state.versions[parsed.id] = `1.0.${n}`;
    }
    return send(res, 200, { id: parsed.id, version: state.versions[parsed.id] });
  }

  if (path === '/k/v1/preview/app/plugins.json' && method === 'GET') {
    const set = state.appPluginsByApp ? (state.appPluginsByApp[q.get('app')] || new Set()) : state.appPlugins;
    const plugins = Array.from(set).map((id) => ({ id, name: 'Sample Plugin', enabled: true }));
    return send(res, 200, { plugins, revision: '1' });
  }

  if (method === 'DELETE') {
    state.deleteCalls.push(path); // アプリからプラグインを外す公式 API は無い。呼ばれたら失敗させる材料
    return send(res, 200, {});
  }

  if (path === '/k/v1/preview/app/plugins.json' && method === 'POST') {
    const parsed = readJsonBody(body);
    state.appPluginsPostCalls.push(parsed);
    for (const id of parsed.ids || []) state.appPlugins.add(id);
    if (state.appPluginsByApp) {
      state.appPluginsByApp[parsed.app] = state.appPluginsByApp[parsed.app] || new Set();
      for (const id of parsed.ids || []) state.appPluginsByApp[parsed.app].add(id);
    }
    return send(res, 200, { revision: '2' });
  }

  if (path === '/k/v1/preview/app/plugin/config.json' && method === 'PUT') {
    state.configPutCalls += 1;
    if (state.configShouldFail) {
      return send(res, 500, { code: 'GAIA_IL19', id: 'mock-err-id', message: 'The API Lab feature is not enabled.' });
    }
    return send(res, 200, {});
  }

  if (path === '/k/v1/preview/app/deploy.json' && method === 'POST') {
    state.deployPostCalls += 1;
    state.deployBodies.push(readJsonBody(body));
    state.deployPollCount = 0;
    return send(res, 200, {});
  }

  if (path === '/k/v1/preview/app/deploy.json' && method === 'GET') {
    state.deployPollCount += 1;
    const status = state.deployPollCount < state.deploySuccessAfterPolls ? 'PROCESSING' : state.deployFinalStatus;
    return send(res, 200, { apps: parseIndexedArray(q, 'apps').map((app) => ({ app, status })) });
  }

  send(res, 404, { code: 'MOCK_NOT_FOUND', message: `no mock route for ${method} ${path}` });
}

// ---- テスト用の下ごしらえ ----

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeEnvFile(dir, baseUrl, { username = 'admin', password = SECRET_PASSWORD, extra = [] } = {}) {
  const file = join(dir, 'kintone.env');
  writeFileSync(
    file,
    [`KINTONE_BASE_URL=${baseUrl}`, `KINTONE_USERNAME=${username}`, `KINTONE_PASSWORD=${password}`, ...extra, ''].join('\n'),
  );
  chmodSync(file, 0o600);
  return file;
}

function runCli(args, { envFile, extraEnv = {}, allowLocal = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, ...args],
      {
        env: {
          ...process.env,
          ...(envFile ? { KIN_ENV_FILE: envFile } : {}),
          ...(allowLocal ? { KIN_ALLOW_LOCAL: '1' } : { KIN_ALLOW_LOCAL: '' }),
          KIN_BACKUP_DIR: BACKUP_DIR,
          ...extraEnv,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      let json;
      try {
        const line = stdout.trim().split('\n').filter(Boolean).pop();
        json = line ? JSON.parse(line) : undefined;
      } catch {
        json = undefined;
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

// ---- env の守りまわり ----

test('pack: 接続設定なしで dist/<name>-<version>.zip を書き、鍵が無ければ止める', async () => {
  const dir = makeTmpDir('kin-loop-pack-');
  const pluginDir = join(dir, 'sample');
  cpSync(FIXTURE_PLUGIN_DIR, pluginDir, { recursive: true });
  try {
    const noKey = await runCli(['pack', pluginDir], { envFile: join(dir, 'does-not-exist.env') });
    assert.equal(noKey.code, 1);
    assert.equal(noKey.json.error.code, 'no_key');
    const missing = await runCli(['pack', join(dir, 'nope')], { envFile: join(dir, 'does-not-exist.env') });
    assert.equal(missing.json.error.code, 'no_manifest');
    // 反映済みと同じ状態(鍵あり)にしてから
    const { generatePpk } = await import('../tools/kin-scaffold.mjs');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(pluginDir, '.keys'));
    writeFileSync(join(pluginDir, '.keys', 'sample.ppk'), generatePpk(), { mode: 0o600 });
    const r = await runCli(['pack', pluginDir], { envFile: join(dir, 'does-not-exist.env') });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    const version = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8')).version;
    assert.equal(r.json.file, join(pluginDir, 'dist', `sample-${version}.zip`));
    assert.ok(statSync(r.json.file).size > 0);
    assert.match(r.json.pluginId, /^[a-p]{32}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env ファイルが無いと missing で exit 2', async () => {
  const dir = makeTmpDir('kin-loop-noenv-');
  try {
    const { code, json } = await runCli(['apps'], { envFile: join(dir, 'does-not-exist.env') });
    assert.equal(code, 2);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('本番ホストは denied で exit 2', async () => {
  const dir = makeTmpDir('kin-loop-denied-');
  try {
    const envFile = writeEnvFile(dir, 'https://example.cybozu.com');
    const { code, json } = await runCli(['apps'], { envFile, allowLocal: false });
    assert.equal(code, 2);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'denied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- apps ----

test('apps はページングして全件集める', async () => {
  const state = defaultState();
  state.apps = Array.from({ length: 130 }, (_, i) => ({ appId: String(i + 1), name: `App ${i + 1}` }));
  const mock = await startMockServer(state);
  const dir = makeTmpDir('kin-loop-apps-');
  try {
    const envFile = writeEnvFile(dir, mock.baseUrl);
    const { code, json, stdout } = await runCli(['apps'], { envFile });
    assert.equal(code, 0);
    assert.equal(json.ok, true);
    assert.equal(json.apps.length, 130);
    assert.deepEqual(json.apps[0], { appId: '1', name: 'App 1', spaceId: null });
    assert.deepEqual(json.apps[129], { appId: '130', name: 'App 130', spaceId: null });
    assert.ok(state.lastAuthHeader, 'X-Cybozu-Authorization が付いている');
    assert.equal(state.lastAuthHeader, Buffer.from(`admin:${SECRET_PASSWORD}`).toString('base64'));
    assert.ok(!stdout.includes(SECRET_PASSWORD), '出力にパスワードが出ない');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- form ----

test('form はサブテーブルを展開し plugins/customize も返す', async () => {
  const state = defaultState();
  state.formFields = {
    properties: {
      Text_1: { code: 'Text_1', label: 'テキスト', type: 'SINGLE_LINE_TEXT', required: true },
      Radio_1: { code: 'Radio_1', label: '区分', type: 'RADIO_BUTTON', required: false, options: { B: { label: 'B', index: '1' }, A: { label: 'A', index: '0' } } },
      Table_1: {
        code: 'Table_1',
        label: 'テーブル',
        type: 'SUBTABLE',
        fields: {
          Number_1: { code: 'Number_1', label: '数値', type: 'NUMBER' },
        },
      },
    },
    revision: '3',
  };
  state.appPluginsResponse = { plugins: [{ id: 'abc123', name: 'Installed Plugin', enabled: true }], revision: '1' };
  state.customize = {
    scope: 'ALL',
    desktop: {
      js: [{ type: 'FILE', file: { name: 'desktop.js', fileKey: 'fk1', contentType: 'text/javascript', size: '10' } }],
      css: [{ type: 'URL', url: 'https://example.com/style.css' }],
    },
    mobile: { js: [], css: [] },
    revision: '3',
  };
  state.views = {
    今月: { id: '202', name: '今月', type: 'LIST', index: '1' },
    全て: { id: '201', name: '全て', type: 'LIST', index: '0' },
  };
  const mock = await startMockServer(state);
  const dir = makeTmpDir('kin-loop-form-');
  try {
    const envFile = writeEnvFile(dir, mock.baseUrl);
    const { code, json } = await runCli(['form', '5'], { envFile });
    assert.equal(code, 0);
    assert.equal(json.ok, true);
    assert.deepEqual(json.views, [{ id: '201', name: '全て', type: 'LIST' }, { id: '202', name: '今月', type: 'LIST' }], '一覧は index 順・ID は文字列');
    assert.deepEqual(json.fields, [
      { code: 'Text_1', label: 'テキスト', type: 'SINGLE_LINE_TEXT', required: true },
      { code: 'Radio_1', label: '区分', type: 'RADIO_BUTTON', required: false, options: ['A', 'B'] },
      {
        code: 'Table_1',
        label: 'テーブル',
        type: 'SUBTABLE',
        required: false,
        subtable: [{ code: 'Number_1', label: '数値', type: 'NUMBER', required: false }],
      },
    ]);
    assert.deepEqual(json.plugins, [{ id: 'abc123', name: 'Installed Plugin' }]);
    assert.deepEqual(json.customize.desktop, { js: ['desktop.js'], css: ['https://example.com/style.css'] });
    assert.deepEqual(json.customize.mobile, { js: [], css: [] });
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('form は layout と appName も返す(取れなければ省く)', async () => {
  const layout = [{ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'Text_1', size: { width: '200' } }] }];
  const dir = makeTmpDir('kin-loop-form-layout-');
  for (const withMap of [true, false]) {
    const state = defaultState();
    state.formFields = { properties: { Text_1: { code: 'Text_1', label: 'テキスト', type: 'SINGLE_LINE_TEXT' } }, revision: '1' };
    if (withMap) {
      state.formLayout = { layout, revision: '1' };
      state.appInfo = { appId: '5', name: '製造管理' };
    }
    const mock = await startMockServer(state);
    try {
      const envFile = writeEnvFile(dir, mock.baseUrl);
      const { code, json } = await runCli(['form', '5'], { envFile });
      assert.equal(code, 0);
      assert.equal(json.ok, true);
      assert.equal(json.fields.length, 1);
      if (withMap) {
        assert.deepEqual(json.layout, layout);
        assert.equal(json.appName, '製造管理');
      } else {
        assert.equal('layout' in json, false, '取れなければ layout は省く');
        assert.equal('appName' in json, false);
      }
    } finally {
      await mock.close();
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---- deploy ----

test('deploy: 鍵が無い初回は新規作成して install、2回目は同じ pluginId で update+skip', async () => {
  const state = defaultState();
  const mock = await startMockServer(state);
  const workDir = makeTmpDir('kin-loop-deploy-');
  const pluginDir = join(workDir, 'plugin');
  cpSync(FIXTURE_PLUGIN_DIR, pluginDir, { recursive: true });
  try {
    const envFile = writeEnvFile(workDir, mock.baseUrl);

    // 1回目: 鍵が無い -> 新規作成、install(POST)、preview へ追加
    const first = await runCli(['deploy', pluginDir, '42'], { envFile });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.ok, true);
    assert.ok(first.json.pluginId);
    assert.equal(first.json.appId, '42');
    assert.equal(typeof first.json.seconds, 'number');
    assert.equal(first.json.origin, new URL(mock.baseUrl).origin, 'origin はホストだけ(画面の URL 用)');

    const packStep = first.json.steps.find((s) => s.name === 'pack');
    assert.equal(packStep.ok, true);
    assert.ok(packStep.note && packStep.note.includes('新規作成'));

    const keysDir = join(pluginDir, '.keys');
    const keyFiles = readdirSync(keysDir).filter((f) => f.endsWith('.ppk'));
    assert.equal(keyFiles.length, 1, '.keys に鍵が1本残る');

    assert.equal(state.pluginPostCalls.length, 1, '初回は POST /k/v1/plugin.json');
    assert.equal(state.pluginPutCalls.length, 0);
    assert.equal(state.appPluginsPostCalls.length, 1, '初回はアプリへの追加 POST が呼ばれる');
    assert.equal(state.appPluginsPostCalls[0].app, '42');
    assert.deepEqual(state.appPluginsPostCalls[0].ids, [first.json.pluginId]);

    const installStep1 = first.json.steps.find((s) => s.name === 'install');
    assert.equal(installStep1.detail.action, 'install');
    const appPluginsStep1 = first.json.steps.find((s) => s.name === 'app-plugins');
    assert.ok(!appPluginsStep1.skipped);
    const deployStep1 = first.json.steps.find((s) => s.name === 'deploy');
    assert.equal(deployStep1.ok, true);
    assert.equal(deployStep1.detail.status, 'SUCCESS');

    // 2回目: 同じ鍵を再利用 -> 同じ pluginId、既に導入済みなので update(PUT)、app-plugins は skip
    const second = await runCli(['deploy', pluginDir, '42'], { envFile });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.ok, true);
    assert.equal(second.json.pluginId, first.json.pluginId, '2回目も同じ pluginId');

    const keyFilesAfter = readdirSync(keysDir).filter((f) => f.endsWith('.ppk'));
    assert.deepEqual(keyFilesAfter, keyFiles, '鍵ファイルは増えない(同じものを再利用)');

    assert.equal(state.pluginPostCalls.length, 1, '2回目は POST が増えない');
    assert.equal(state.pluginPutCalls.length, 1, '2回目は PUT /k/v1/plugin.json');
    assert.equal(state.pluginPutCalls[0].id, first.json.pluginId);

    const installStep2 = second.json.steps.find((s) => s.name === 'install');
    assert.equal(installStep2.detail.action, 'update');
    const appPluginsStep2 = second.json.steps.find((s) => s.name === 'app-plugins');
    assert.equal(appPluginsStep2.skipped, true, '2回目は既に追加済みなので skip');
    assert.equal(state.appPluginsPostCalls.length, 1, 'skip なので POST は増えない');
  } finally {
    await mock.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('deploy: relay.config.json が前回と同じなら設定値を送らない(画面で選び直した値を残す)・変えたら送る', async () => {
  const state = defaultState();
  const mock = await startMockServer(state);
  const workDir = makeTmpDir('kin-loop-config-same-');
  const pluginDir = join(workDir, 'plugin');
  cpSync(FIXTURE_PLUGIN_DIR, pluginDir, { recursive: true });
  try {
    const envFile = writeEnvFile(workDir, mock.baseUrl);
    const configFile = join(workDir, 'config.json');
    writeFileSync(configFile, JSON.stringify({ fieldCode: 'qty' }));
    const first = await runCli(['deploy', pluginDir, '7', '--config', configFile], { envFile });
    assert.equal(first.json.steps.find((s) => s.name === 'config').ok, true);
    assert.equal(state.configPutCalls, 1);
    const second = await runCli(['deploy', pluginDir, '7', '--config', configFile], { envFile });
    const st = second.json.steps.find((s) => s.name === 'config');
    assert.equal(st.unchanged, true);
    assert.equal(state.configPutCalls, 1, '同じ値は送らない');
    writeFileSync(configFile, JSON.stringify({ fieldCode: 'amount' }));
    await runCli(['deploy', pluginDir, '7', '--config', configFile], { envFile });
    assert.equal(state.configPutCalls, 2, '変えたら送る');
  } finally {
    await mock.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('deploy: --config が失敗しても deploy まで進む', async () => {
  const state = defaultState();
  state.configShouldFail = true;
  const mock = await startMockServer(state);
  const workDir = makeTmpDir('kin-loop-config-');
  const pluginDir = join(workDir, 'plugin');
  cpSync(FIXTURE_PLUGIN_DIR, pluginDir, { recursive: true });
  try {
    const envFile = writeEnvFile(workDir, mock.baseUrl);
    const configFile = join(workDir, 'config.json');
    writeFileSync(configFile, JSON.stringify({ apiKey: 'dummy-value', limit: 10 }));

    const { code, json, stderr } = await runCli(['deploy', pluginDir, '7', '--config', configFile], { envFile });
    assert.equal(code, 0, stderr);
    assert.equal(json.ok, true);

    const configStep = json.steps.find((s) => s.name === 'config');
    assert.equal(configStep.ok, false);
    assert.equal(configStep.skipped, true);
    assert.match(configStep.note, /^設定は画面で/);

    const deployStep = json.steps.find((s) => s.name === 'deploy');
    assert.equal(deployStep.ok, true);
    assert.equal(state.configPutCalls, 1);
  } finally {
    await mock.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('deploy: 反映が FAIL なら exit 1 で error を返す', async () => {
  const state = defaultState();
  state.deployFinalStatus = 'FAIL';
  state.deploySuccessAfterPolls = 1;
  const mock = await startMockServer(state);
  const workDir = makeTmpDir('kin-loop-fail-');
  const pluginDir = join(workDir, 'plugin');
  cpSync(FIXTURE_PLUGIN_DIR, pluginDir, { recursive: true });
  try {
    const envFile = writeEnvFile(workDir, mock.baseUrl);
    const { code, json } = await runCli(['deploy', pluginDir, '9'], { envFile });
    assert.equal(code, 1);
    assert.equal(json.ok, false);
    assert.ok(json.error);
    assert.equal(json.error.step, 'deploy');
    assert.match(json.error.message, /FAIL/);

    const deployStep = json.steps.find((s) => s.name === 'deploy');
    assert.equal(deployStep.ok, false);
  } finally {
    await mock.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('deploy: --ppk で指定した鍵を使う', async () => {
  const state = defaultState();
  const mock = await startMockServer(state);
  const workDir = makeTmpDir('kin-loop-ppk-');
  const pluginDir = join(workDir, 'plugin');
  cpSync(FIXTURE_PLUGIN_DIR, pluginDir, { recursive: true });
  try {
    const envFile = writeEnvFile(workDir, mock.baseUrl);

    // 先に一度 pack して鍵を作り、.keys の外に退避してから --ppk で渡す
    const pre = await runCli(['deploy', pluginDir, '1'], { envFile });
    assert.equal(pre.code, 0, pre.stderr);
    const keysDir = join(pluginDir, '.keys');
    const keyFileName = readdirSync(keysDir).find((f) => f.endsWith('.ppk'));
    const ppkPath = join(workDir, 'moved.ppk');
    writeFileSync(ppkPath, readFileSync(join(keysDir, keyFileName), 'utf8'));
    rmSync(join(keysDir, keyFileName));

    const { code, json } = await runCli(['deploy', pluginDir, '1', '--ppk', ppkPath], { envFile });
    assert.equal(code, 0);
    assert.equal(json.pluginId, pre.json.pluginId, '--ppk を渡すと同じ pluginId になる');
    const packStep = json.steps.find((s) => s.name === 'pack');
    assert.ok(!packStep.note, '--ppk 指定時は鍵を新規作成しない');
  } finally {
    await mock.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('ファイルアップロードは multipart/form-data で送る', async () => {
  const state = defaultState();
  const mock = await startMockServer(state);
  const workDir = makeTmpDir('kin-loop-upload-');
  const pluginDir = join(workDir, 'plugin');
  cpSync(FIXTURE_PLUGIN_DIR, pluginDir, { recursive: true });
  try {
    const envFile = writeEnvFile(workDir, mock.baseUrl);
    const { code } = await runCli(['deploy', pluginDir, '3'], { envFile });
    assert.equal(code, 0);
    assert.equal(state.fileUploadCount, 1);
    assert.ok(state.fileUploadContentType && state.fileUploadContentType.startsWith('multipart/form-data'));
  } finally {
    await mock.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});


// ---- v0.2: 控え / 本番の許可 / undo ----

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function freshBackupDir() {
  return mkdtempSync(join(tmpdir(), 'kin-backup-'));
}

async function withPluginDir(prefix, fn, extra = []) {
  const state = defaultState();
  const mock = await startMockServer(state);
  const workDir = makeTmpDir(prefix);
  const pluginDir = join(workDir, 'plugin');
  cpSync(FIXTURE_PLUGIN_DIR, pluginDir, { recursive: true });
  const backupDir = freshBackupDir();
  try {
    const envFile = writeEnvFile(workDir, mock.baseUrl, { extra });
    await fn({ state, mock, workDir, pluginDir, envFile, backupDir, run: (args) => runCli(args, { envFile, extraEnv: { KIN_BACKUP_DIR: backupDir } }) });
  } finally {
    await mock.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
}

test('backup: deploy の前に <host>/<app>/<時刻>.json を 600 で書き、zip も残す(秘密は入れない)', async () => {
  await withPluginDir('kin-backup-', async ({ state, pluginDir, backupDir, run }) => {
    const first = await run(['deploy', pluginDir, '42']);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(first.json.steps.map((s) => s.name).indexOf('backup') < first.json.steps.map((s) => s.name).indexOf('upload'), 'backup は upload より前');
    const files = walk(backupDir);
    const json = files.filter((f) => f.endsWith('.json'));
    assert.equal(json.length, 1);
    assert.match(json[0], /127\.0\.0\.1_\d+\/42\/\d{4}-\d\d-\d\dT[\d.-]+Z\.json$/);
    assert.equal(statSync(json[0]).mode & 0o777, 0o600);
    assert.equal(statSync(join(json[0], '..')).mode & 0o777, 0o700);
    const b = JSON.parse(readFileSync(json[0], 'utf8'));
    assert.equal(b.appId, '42');
    assert.equal(b.pluginId, first.json.pluginId);
    assert.equal(b.wasOnApp, false);
    assert.equal(b.installed, null);
    assert.equal(b.prevZip, null);
    assert.ok(Array.isArray(b.appPlugins));
    const zips = files.filter((f) => f.endsWith('.zip'));
    assert.equal(zips.length, 1, '入れ終えた zip が木に残る');
    assert.equal(statSync(zips[0]).mode & 0o777, 0o600);
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      const t = readFileSync(f, 'utf8');
      assert.ok(!t.includes(SECRET_PASSWORD) && !t.includes('X-Cybozu'), '控えに秘密が入らない');
    }

    // 2回目: 控えに「入っていた版」と前の zip が入る
    const second = await run(['deploy', pluginDir, '42']);
    assert.equal(second.code, 0, second.stderr);
    const latest = walk(backupDir).filter((f) => f.endsWith('.json')).sort().pop();
    const b2 = JSON.parse(readFileSync(latest, 'utf8'));
    assert.equal(b2.wasOnApp, true);
    assert.deepEqual(b2.installed, { id: first.json.pluginId, version: '1.0.0' });
    assert.ok(b2.prevZip && existsSync(b2.prevZip));
    assert.equal(state.deleteCalls.length, 0);
  });
});

test('本番: PROD_APPS 以外のアプリへの deploy は denied(番号入り・何も触らない)、読むだけは通る', async () => {
  await withPluginDir('kin-prod-', async ({ state, pluginDir, backupDir, run }) => {
    const denied = await run(['deploy', pluginDir, '5']);
    assert.equal(denied.code, 2);
    assert.equal(denied.json.ok, false);
    assert.equal(denied.json.error.code, 'denied');
    assert.match(denied.json.error.message, /アプリ 5 /);
    assert.ok(!denied.stdout.includes(SECRET_PASSWORD) && !denied.stderr.includes(SECRET_PASSWORD));
    assert.equal(state.fileUploadCount, 0);
    assert.equal(state.pluginPostCalls.length, 0);
    assert.equal(readdirSync(backupDir).length, 0, '拒否では控えも書かない');

    const undoDenied = await run(['undo', '5']);
    assert.equal(undoDenied.json.error.code, 'denied');

    const apps = await run(['apps']);
    assert.equal(apps.code, 0);
    assert.equal(apps.json.mode, 'prod');
    const form = await run(['form', '5']);
    assert.equal(form.code, 0);

    const mode5 = await run(['mode', '5']);
    assert.equal(mode5.json.error.code, 'denied');
    const mode96 = await run(['mode', '42']);
    assert.deepEqual([mode96.json.ok, mode96.json.mode], [true, 'prod']);

    const ok = await run(['deploy', pluginDir, '42']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.json.mode, 'prod');
    assert.equal(state.pluginPostCalls.length, 1);
  }, ['KINTONE_PROD_HOST=127.0.0.1', 'KINTONE_PROD_APPS=42, 97']);
});

test('本番: PROD_APPS が空なら本番への deploy は全部 denied。dev は常に通る', async () => {
  await withPluginDir('kin-prod-empty-', async ({ state, pluginDir, run }) => {
    const r = await run(['deploy', pluginDir, '42']);
    assert.equal(r.json.error.code, 'denied');
    assert.equal(state.fileUploadCount, 0);
  }, ['KINTONE_PROD_HOST=127.0.0.1']);
  await withPluginDir('kin-dev-', async ({ pluginDir, run }) => {
    const m = await run(['mode', '5']);
    assert.deepEqual([m.json.ok, m.json.mode], [true, 'dev']);
    const r = await run(['deploy', pluginDir, '5']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.mode, 'dev');
  });
});

test('undo: 前の版が控えにあれば再アップロードして PUT し、反映する(外す API は呼ばない)', async () => {
  await withPluginDir('kin-undo-', async ({ state, pluginDir, run }) => {
    const first = await run(['deploy', pluginDir, '42']);
    await run(['deploy', pluginDir, '42']);
    assert.equal(state.versions[first.json.pluginId], '1.0.1');
    const putsBefore = state.pluginPutCalls.length;
    const deploysBefore = state.deployPostCalls;
    const uploadsBefore = state.fileUploadCount;

    const u = await run(['undo', '42']);
    assert.equal(u.code, 0, u.stderr);
    assert.equal(u.json.ok, true);
    assert.equal(u.json.restored, true);
    assert.equal(u.json.deployed, true);
    assert.equal(state.pluginPutCalls.length, putsBefore + 1);
    assert.equal(state.pluginPutCalls.at(-1).id, first.json.pluginId);
    assert.equal(state.fileUploadCount, uploadsBefore + 1);
    assert.equal(state.deployPostCalls, deploysBefore + 1);
    assert.equal(state.deleteCalls.length, 0);
    assert.equal(u.json.parts.find((p) => p.name === 'plugin-version').status, 'restored');
    assert.equal(u.json.parts.find((p) => p.name === 'app-plugin').status, 'unchanged');
    assert.deepEqual(u.json.cannot, []);

    // 戻した控えには印が付き、もう一度は使われない(さらに前の控えが無いので「控えなし」ではなく 1回目の控え)
    const again = await run(['undo', '42']);
    assert.equal(again.json.parts.find((p) => p.name === 'app-plugin').status, 'cannot', '1回目の控えは「アプリに無かった」');
  });
});

test('undo: 元はアプリに無かったプラグインは「戻せません」と正直に返し、何も消さない・反映もしない', async () => {
  await withPluginDir('kin-undo-cannot-', async ({ state, pluginDir, run }) => {
    await run(['deploy', pluginDir, '42']);
    const deploysBefore = state.deployPostCalls;
    const u = await run(['undo', '42']);
    assert.equal(u.code, 0, u.stderr);
    assert.equal(u.json.restored, false);
    assert.equal(u.json.deployed, false);
    assert.deepEqual(u.json.cannot, ['app-plugin', 'plugin-version']);
    const app = u.json.parts.find((p) => p.name === 'app-plugin');
    assert.match(app.message, /^戻せません: 画面で外してください/);
    assert.equal(state.deleteCalls.length, 0, 'DELETE は一切呼ばない');
    assert.equal(state.deployPostCalls, deploysBefore, '戻した物が無ければ反映しない');
  });
});

test('undo: 控えが無ければ戻せませんで終わる / 前の zip が無ければ版は戻せません', async () => {
  await withPluginDir('kin-undo-none-', async ({ pluginDir, backupDir, run }) => {
    const none = await run(['undo', '42']);
    assert.equal(none.json.ok, false);
    assert.match(none.json.error.message, /戻せません/);

    await run(['deploy', pluginDir, '42']);
    await run(['deploy', pluginDir, '42']);
    for (const f of walk(backupDir).filter((f) => f.endsWith('.zip'))) rmSync(f);
    const u = await run(['undo', '42']);
    const v = u.json.parts.find((p) => p.name === 'plugin-version');
    assert.equal(v.status, 'cannot');
    assert.match(v.message, /^戻せません: .*zip が控えにありません/);
    assert.equal(u.json.restored, false);
  });
});


// ---- v0.3: status / plugins / records / backups / customize ----

test('apps: spaceId を返す(無ければ null)', async () => {
  await withPluginDir('kin-apps-space-', async ({ state, run }) => {
    state.apps = [{ appId: '1', name: 'A', spaceId: '7' }, { appId: '2', name: 'B', spaceId: null }];
    const r = await run(['apps']);
    assert.deepEqual(r.json.apps, [{ appId: '1', name: 'A', spaceId: '7' }, { appId: '2', name: 'B', spaceId: null }]);
  });
});

test('status: 通信なしで mode/host/prodApps/relayVersion/backups を返し、秘密は出さない', async () => {
  await withPluginDir('kin-status-', async ({ state, pluginDir, run }) => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const before = await run(['status']);
    assert.equal(before.code, 0);
    assert.deepEqual(
      { ok: before.json.ok, mode: before.json.mode, prodApps: before.json.prodApps, relayVersion: before.json.relayVersion, backups: before.json.backups },
      { ok: true, mode: 'prod', prodApps: ['42', '97'], relayVersion: pkg.version, backups: 0 },
    );
    assert.match(before.json.host, /^127\.0\.0\.1:\d+$/);
    await run(['deploy', pluginDir, '42']);
    const after = await run(['status']);
    assert.equal(after.json.backups, 1);
    assert.equal(state.lastAuthHeader && true, true);
    for (const r of [before, after]) {
      assert.ok(!r.stdout.includes(SECRET_PASSWORD) && !r.stdout.includes(Buffer.from(`admin:${SECRET_PASSWORD}`).toString('base64')));
    }
  }, ['KINTONE_PROD_HOST=127.0.0.1', 'KINTONE_PROD_APPS=42, 97']);
  const dir = makeTmpDir('kin-status-missing-');
  try {
    const r = await runCli(['status'], { envFile: join(dir, 'none.env') });
    assert.equal(r.json.error.code, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugins: プラグインと customize(URL/FILE)を返す', async () => {
  await withPluginDir('kin-plugins-', async ({ state, run }) => {
    state.appPluginsResponse = { plugins: [{ id: 'p1', name: 'P One', enabled: true }, { id: 'p2', name: 'P Two', enabled: false }] };
    state.customize = {
      scope: 'ALL',
      desktop: { js: [{ type: 'FILE', file: { name: 'a.js', fileKey: 'secret-key-1' } }, { type: 'URL', url: 'https://e.com/x.js' }], css: [] },
      mobile: { js: [], css: [{ type: 'URL', url: 'https://e.com/m.css' }] },
    };
    const r = await run(['plugins', '5']);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, {
      ok: true,
      appId: '5',
      plugins: [{ id: 'p1', name: 'P One', enabled: true }, { id: 'p2', name: 'P Two', enabled: false }],
      customize: {
        desktop: { js: [{ type: 'FILE', name: 'a.js' }, { type: 'URL', url: 'https://e.com/x.js' }], css: [] },
        mobile: { js: [], css: [{ type: 'URL', url: 'https://e.com/m.css' }] },
      },
    });
    assert.ok(!r.stdout.includes('secret-key-1'));
    assert.equal((await run(['plugins'])).code, 2);
  });
});

test('records: 値を平らにし(FILE は名前だけ)、limit は 20 で頭打ち・既定 10・fields を渡す', async () => {
  await withPluginDir('kin-records-', async ({ state, run }) => {
    state.recordsTotal = '57';
    state.records = [{
      title: { type: 'SINGLE_LINE_TEXT', value: 'こんにちは' },
      files: { type: 'FILE', value: [{ name: 'a.png', fileKey: 'fk-secret', size: '1', contentType: 'image/png' }] },
      tbl: { type: 'SUBTABLE', value: [{ id: '1', value: { qty: { type: 'NUMBER', value: '3' } } }] },
      who: { type: 'USER_SELECT', value: [{ code: 'u', name: 'U' }] },
    }];
    const r = await run(['records', '5', '--fields', 'title,files,tbl,who']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, {
      ok: true,
      appId: '5',
      totalCount: 57,
      records: [{ title: 'こんにちは', files: ['a.png'], tbl: [{ qty: '3' }], who: [{ code: 'u', name: 'U' }] }],
    });
    assert.ok(!r.stdout.includes('fk-secret'));
    assert.equal(state.recordsCalls[0].query, 'limit 10');
    assert.deepEqual(state.recordsCalls[0].fields, ['title', 'files', 'tbl', 'who']);

    await run(['records', '5', '--limit', '500', '--query', 'title = "x" order by $id desc']);
    assert.equal(state.recordsCalls[1].query, 'title = "x" order by $id desc limit 20');
    await run(['records', '5', '--limit', '5', '--query', 'a = 1 limit 100 offset 3']);
    assert.equal(state.recordsCalls[2].query, 'a = 1 limit 5 offset 3');
    await run(['records', '5', '--query', 'limit 300']);
    assert.equal(state.recordsCalls[3].query, 'limit 10');
    const bad = await run(['records', '5', '--limit', 'abc']);
    assert.equal(bad.json.ok, false);
    assert.equal(state.recordsCalls.length, 4);

    // サーバーが多く返しても 20 件に切る
    state.records = Array.from({ length: 50 }, (_, i) => ({ n: { type: 'NUMBER', value: String(i) } }));
    const many = await run(['records', '5', '--limit', '99']);
    assert.equal(many.json.records.length, 20);
  });
});

test('records: 本番でも PROD_APPS 外のアプリを読める', async () => {
  await withPluginDir('kin-records-prod-', async ({ run }) => {
    const r = await run(['records', '5']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
  }, ['KINTONE_PROD_HOST=127.0.0.1', 'KINTONE_PROD_APPS=42']);
});

test('customize: 本番の PROD_APPS 外は denied(何も触らない)', async () => {
  await withPluginDir('kin-customize-denied-', async ({ state, workDir, backupDir, run }) => {
    const js = join(workDir, 'a.js');
    writeFileSync(js, 'console.log(1)');
    const r = await run(['customize', '5', '--js', js]);
    assert.equal(r.code, 2);
    assert.equal(r.json.error.code, 'denied');
    assert.equal(state.fileUploadCount, 0);
    assert.equal(state.customizePutCalls.length, 0);
    assert.equal(readdirSync(backupDir).length, 0);
    assert.ok(!r.stdout.includes(SECRET_PASSWORD));
    const ok = await run(['customize', '42', '--js', js]);
    assert.equal(ok.code, 0, ok.stderr);
  }, ['KINTONE_PROD_HOST=127.0.0.1', 'KINTONE_PROD_APPS=42']);
});

test('customize: アップロード→PUT→deploy。--keep-urls で既存 URL を残す。控えは kind:customize で fileKey を持たない', async () => {
  await withPluginDir('kin-customize-', async ({ state, workDir, backupDir, run }) => {
    state.previewCustomize = {
      scope: 'ALL',
      desktop: { js: [{ type: 'URL', url: 'https://e.com/old.js' }, { type: 'FILE', file: { name: 'old.js', fileKey: 'old-key', size: '3' } }], css: [] },
      mobile: { js: [], css: [{ type: 'URL', url: 'https://e.com/m.css' }] },
      revision: '4',
    };
    const js = join(workDir, 'new.js');
    const css = join(workDir, 'new.css');
    writeFileSync(js, 'console.log(1)');
    writeFileSync(css, 'a{}');
    const r = await run(['customize', '5', '--js', js, '--css', css, '--mobile-js', js, '--keep-urls']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.appId, '5');
    assert.equal(typeof r.json.seconds, 'number');
    assert.deepEqual(r.json.steps.map((s) => s.name), ['backup', 'upload desktop.js', 'upload desktop.css', 'upload mobile.js', 'customize', 'deploy']);
    assert.equal(state.fileUploadCount, 3);
    assert.equal(state.deployPostCalls, 1);
    assert.deepEqual(state.customizePutCalls[0], {
      app: '5',
      scope: 'ALL',
      desktop: { js: [{ type: 'URL', url: 'https://e.com/old.js' }, { type: 'FILE', file: { fileKey: state.fileKey } }], css: [{ type: 'FILE', file: { fileKey: state.fileKey } }] },
      mobile: { js: [{ type: 'FILE', file: { fileKey: state.fileKey } }], css: [{ type: 'URL', url: 'https://e.com/m.css' }] },
    });
    const files = walk(backupDir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const text = readFileSync(files[0], 'utf8');
    assert.equal(JSON.parse(text).kind, 'customize');
    assert.ok(!text.includes('old-key') && !text.includes(SECRET_PASSWORD));
    assert.equal(statSync(files[0]).mode & 0o777, 0o600);
    assert.ok(!r.stdout.includes(SECRET_PASSWORD));

    // --keep-urls 無しなら URL は残らない
    await run(['customize', '5', '--js', js]);
    assert.deepEqual(state.customizePutCalls[1].desktop.js, [{ type: 'FILE', file: { fileKey: state.fileKey } }]);
    assert.deepEqual(state.customizePutCalls[1].mobile, { js: [], css: [] });

    // 指定が何も無い / ファイルが読めない
    const none = await run(['customize', '5']);
    assert.equal(none.json.ok, false);
    const missing = await run(['customize', '5', '--js', join(workDir, 'nope.js')]);
    assert.equal(missing.json.ok, false);
    assert.equal(state.customizePutCalls.length, 2);
  });
});

test('customize: deploy が FAIL なら ok:false', async () => {
  await withPluginDir('kin-customize-fail-', async ({ state, workDir, run }) => {
    state.deployFinalStatus = 'FAIL';
    const js = join(workDir, 'a.js');
    writeFileSync(js, 'x');
    const r = await run(['customize', '5', '--js', js]);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.step, 'deploy');
  });
});

test('backups: 新しい順・undone の印・customize も出る / undo は customize の控えを URL だけ戻す', async () => {
  await withPluginDir('kin-backups-undo-', async ({ state, pluginDir, workDir, run }) => {
    await run(['deploy', pluginDir, '5']);
    state.previewCustomize = {
      scope: 'ALL',
      desktop: { js: [{ type: 'URL', url: 'https://e.com/keep.js' }, { type: 'FILE', file: { name: 'gone.js', fileKey: 'k' } }], css: [] },
      mobile: { js: [], css: [] },
    };
    const js = join(workDir, 'a.js');
    writeFileSync(js, 'x');
    await run(['customize', '5', '--js', js]);

    const list = await run(['backups', '5']);
    assert.equal(list.code, 0);
    assert.equal(list.json.appId, '5');
    assert.equal(list.json.backups.length, 2);
    assert.equal(list.json.backups[0].kind, 'customize');
    assert.equal(list.json.backups[0].undone, false);
    
    assert.ok(list.json.backups[1].pluginId);
    assert.match(list.json.backups[0].file, /\.json$/);
    assert.ok(!list.json.backups[0].file.includes('/'));
    assert.ok(list.json.backups[0].file > list.json.backups[1].file, '新しい順');

    const deploysBefore = state.deployPostCalls;
    const u = await run(['undo', '5']);
    assert.equal(u.code, 0, u.stderr);
    assert.equal(u.json.kind, 'customize');
    assert.equal(u.json.restored, true);
    assert.equal(u.json.deployed, true);
    assert.deepEqual(u.json.cannot, ['customize-files']);
    assert.match(u.json.parts.find((p) => p.name === 'customize-files').message, /^戻せません/);
    const put = state.customizePutCalls[state.customizePutCalls.length - 1];
    assert.deepEqual(put.desktop.js, [{ type: 'URL', url: 'https://e.com/keep.js' }]);
    assert.equal(state.deployPostCalls, deploysBefore + 1);
    assert.equal(state.deleteCalls.length, 0);

    const after = await run(['backups', '5']);
    assert.equal(after.json.backups[0].undone, true);
    assert.equal(after.json.backups[1].undone, false);
    assert.ok(!u.stdout.includes('"fileKey"'));
  });
});


// ---- v0.8: form の lookup/unique/defaultValue・deploy の複数アプリと build・form-change ----

test('form: unique / lookup / defaultValue / referenceTable を返す(ルックアップは元の型+lookup・relatedApp は空を落とす)', async () => {
  const state = defaultState();
  state.formFields = {
    properties: {
      Plain: { code: 'Plain', label: '素', type: 'SINGLE_LINE_TEXT', required: false, unique: false, defaultValue: '' },
      Code: { code: 'Code', label: '品番', type: 'SINGLE_LINE_TEXT', required: true, unique: true, defaultValue: 'A-1' },
      Check: { code: 'Check', label: '確認', type: 'CHECK_BOX', defaultValue: [], options: { x: { label: 'x', index: '0' } } },
      Mat: {
        code: 'Mat',
        label: '資材',
        type: 'SINGLE_LINE_TEXT',
        unique: 'true',
        lookup: {
          relatedApp: { app: '77', code: '' },
          relatedKeyField: 'code',
          fieldMappings: [{ field: 'Name', relatedField: 'name' }],
          lookupPickerFields: ['code', 'name'],
          filterCond: '',
          sort: 'code asc',
        },
      },
      Ref: {
        code: 'Ref',
        label: '関連',
        type: 'REFERENCE_TABLE',
        referenceTable: {
          relatedApp: { app: '88', code: 'ORDERS' },
          condition: { field: 'Code', relatedField: 'code' },
          filterCond: '',
          displayFields: ['code'],
          size: '5',
        },
      },
    },
    revision: '2',
  };
  const mock = await startMockServer(state);
  const dir = makeTmpDir('kin-loop-form-v08-');
  try {
    const envFile = writeEnvFile(dir, mock.baseUrl);
    const { code, json } = await runCli(['form', '5'], { envFile });
    assert.equal(code, 0);
    assert.deepEqual(json.fields[0], { code: 'Plain', label: '素', type: 'SINGLE_LINE_TEXT', required: false }, 'false/空は出さない');
    assert.deepEqual(json.fields[1], { code: 'Code', label: '品番', type: 'SINGLE_LINE_TEXT', required: true, unique: true, defaultValue: 'A-1' });
    assert.equal('defaultValue' in json.fields[2], false, '空配列は出さない');
    assert.deepEqual(json.fields[3], {
      code: 'Mat',
      label: '資材',
      type: 'SINGLE_LINE_TEXT',
      required: false,
      unique: true,
      lookup: {
        relatedApp: { app: '77' },
        relatedKeyField: 'code',
        fieldMappings: [{ field: 'Name', relatedField: 'name' }],
        lookupPickerFields: ['code', 'name'],
        sort: 'code asc',
      },
    });
    assert.deepEqual(json.fields[4].referenceTable, {
      relatedApp: { app: '88', code: 'ORDERS' },
      condition: { field: 'Code', relatedField: 'code' },
      displayFields: ['code'],
    });
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy: --config の最上位 build は送らず、build だけの変更は「前回と同じ」とみなす', async () => {
  await withPluginDir('kin-config-build-', async ({ state, pluginDir, workDir, run }) => {
    const cfgFile = join(workDir, 'relay.config.json');
    const writeCfg = (o) => writeFileSync(cfgFile, JSON.stringify(o));
    writeCfg({ mode: 'a', build: { command: 'npm run build', dir: 'plugins/x/dist' } });
    const first = await run(['deploy', pluginDir, '42', '--config', cfgFile]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(state.configPutCalls, 1);
    const sent = JSON.parse(readFileSync(join(pluginDir, '.keys', 'config-sent-42.json'), 'utf8'));
    assert.deepEqual(sent, { mode: 'a' }, '送った値に build は入らない');

    writeCfg({ mode: 'a', build: { command: 'pnpm build', dir: 'plugins/x/out' } });
    const second = await run(['deploy', pluginDir, '42', '--config', cfgFile]);
    const cfgStep = second.json.steps.find((s) => s.name === 'config');
    assert.equal(cfgStep.unchanged, true, 'build だけ変えても送り直さない');
    assert.equal(state.configPutCalls, 1);

    writeCfg({ mode: 'b', build: { command: 'pnpm build', dir: 'plugins/x/out' } });
    await run(['deploy', pluginDir, '42', '--config', cfgFile]);
    assert.equal(state.configPutCalls, 2, '設定値が変われば送る');
  });
});

test('deploy: build だけの relay.config.json は空の設定を送らない(画面の設定を消さない)', async () => {
  await withPluginDir('kin-config-buildonly-', async ({ state, pluginDir, workDir, run }) => {
    const cfgFile = join(workDir, 'relay.config.json');
    writeFileSync(cfgFile, JSON.stringify({ build: { command: 'npm run build', dir: 'plugins/x/dist' } }));
    const r = await run(['deploy', pluginDir, '42', '--config', cfgFile]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(state.configPutCalls, 0, '空の設定は PUT しない');
    const cfgStep = r.json.steps.find((s) => s.name === 'config');
    assert.equal(cfgStep.skipped, true);
  });
});

test('deploy 複数アプリ: pack/upload/install は1回・app-plugins と config は各アプリ・deploy.json は1回・控えは各アプリ', async () => {
  await withPluginDir('kin-multi-', async ({ state, pluginDir, workDir, backupDir, run }) => {
    state.appPluginsByApp = {};
    const cfgFile = join(workDir, 'relay.config.json');
    writeFileSync(cfgFile, JSON.stringify({ k: 'v', build: { command: 'x', dir: 'y' } }));
    const r = await run(['deploy', pluginDir, '42,43', '--config', cfgFile]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.appId, '42', 'top-level の appId は最初のアプリ');
    assert.equal(state.fileUploadCount, 1, 'upload は1回');
    assert.equal(state.pluginPostCalls.length, 1, 'install は1回');
    assert.deepEqual(state.appPluginsPostCalls.map((c) => c.app), ['42', '43']);
    assert.equal(state.configPutCalls, 2);
    assert.equal(state.deployPostCalls, 1, 'deploy.json は1回');
    assert.deepEqual(state.deployBodies[0], { apps: [{ app: '42' }, { app: '43' }] });
    assert.equal(r.json.steps.filter((s) => s.name === 'pack').length, 1);
    assert.equal(r.json.steps.filter((s) => s.name === 'backup').length, 2);
    assert.equal(r.json.apps.length, 2);
    assert.deepEqual(r.json.apps.map((a) => [a.appId, a.ok]), [['42', true], ['43', true]]);
    for (const a of r.json.apps) {
      const names = a.steps.map((s) => s.name);
      assert.deepEqual(names, ['backup', 'app-plugins', 'config', 'deploy']);
    }
    const files = walk(backupDir).filter((f) => f.endsWith('.json'));
    assert.ok(files.some((f) => f.includes('/42/')) && files.some((f) => f.includes('/43/')), '控えは各アプリ');
  });
});

test('deploy 複数アプリ: 単一アプリの出力に apps は付かない / 本番が混じる複数は prod_denied(何も触らない)', async () => {
  await withPluginDir('kin-multi-single-', async ({ pluginDir, run }) => {
    const r = await run(['deploy', pluginDir, '42']);
    assert.equal(r.json.ok, true);
    assert.equal('apps' in r.json, false);
  });
  await withPluginDir('kin-multi-prod-', async ({ state, pluginDir, backupDir, run }) => {
    const r = await run(['deploy', pluginDir, '42,97']);
    assert.equal(r.code, 2);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'prod_denied');
    assert.equal(state.fileUploadCount, 0);
    assert.equal(readdirSync(backupDir).length, 0);
    const one = await run(['deploy', pluginDir, '42']);
    assert.equal(one.code, 0, one.stderr);
  }, ['KINTONE_PROD_HOST=127.0.0.1', 'KINTONE_PROD_APPS=42,97']);
});

test('deploy 複数アプリ: 反映が FAIL なら全アプリ ok:false・apps に error', async () => {
  await withPluginDir('kin-multi-fail-', async ({ state, pluginDir, run }) => {
    state.deployFinalStatus = 'FAIL';
    const r = await run(['deploy', pluginDir, '42,43']);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.deepEqual(r.json.apps.map((a) => a.ok), [false, false]);
    assert.equal(r.json.error.step, 'deploy');
  });
});

function writeOps(dir, ops) {
  const f = join(dir, `ops-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(ops));
  return f;
}

function formChangeState(state) {
  state.previewForm = {
    revision: '5',
    properties: {
      Code: { code: 'Code', label: '品番', type: 'SINGLE_LINE_TEXT', required: true, unique: true },
      Name: { code: 'Name', label: '品名', type: 'SINGLE_LINE_TEXT' },
      Mat: { code: 'Mat', label: '資材', type: 'SINGLE_LINE_TEXT' },
      Table: { code: 'Table', label: '表', type: 'SUBTABLE', fields: { Qty: { code: 'Qty', label: '数', type: 'NUMBER' } } },
    },
  };
  state.previewLayout = {
    revision: '5',
    layout: [
      { type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'Code' }, { type: 'SINGLE_LINE_TEXT', code: 'Name', size: { width: '200' } }] },
      { type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'Mat' }] },
      { type: 'SUBTABLE', code: 'Table', fields: [{ type: 'NUMBER', code: 'Qty' }] },
    ],
  };
  state.formsByApp = {
    77: { properties: { code: { code: 'code', type: 'SINGLE_LINE_TEXT', unique: true }, name: { code: 'name', type: 'SINGLE_LINE_TEXT', unique: false }, rn: { code: 'rn', type: 'RECORD_NUMBER' } } },
  };
}

test('form-change --plan: 書かずに突き合わせ、summary と warnings を返す', async () => {
  await withPluginDir('kin-fc-plan-', async ({ state, workDir, run }) => {
    formChangeState(state);
    const ops = writeOps(workDir, [
      { add: { code: 'Kind', type: 'DROP_DOWN', label: '区分', options: ['A', 'B'], required: true } },
      { label: { code: 'Name', label: '名称' } },
      { lookup: { code: 'Mat', relatedApp: 77, relatedKeyField: 'code', fieldMappings: [{ field: 'Name', relatedField: 'name' }] } },
      { layoutRow: { fields: ['Kind', 'Mat'] } },
    ]);
    const r = await run(['form-change', '5', '--ops', ops, '--plan']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mode, 'dev');
    assert.deepEqual(r.json.plan.map((p) => [p.i, p.op, p.code]), [[0, 'add', 'Kind'], [1, 'label', 'Name'], [2, 'lookup', 'Mat'], [3, 'layoutRow', 'Kind,Mat']]);
    assert.match(r.json.plan[0].summary, /区分/);
    assert.deepEqual(r.json.warnings, []);
    assert.equal(state.formWrites.length, 0);
    assert.equal(state.layoutPutCalls.length, 0);
    assert.equal(state.deployPostCalls, 0);
  });
});

test('form-change --plan: bad_ops(code 重複・label の欄なし・参照先キーが一意でない/無い)は plan を返さない', async () => {
  await withPluginDir('kin-fc-bad-', async ({ state, workDir, run }) => {
    formChangeState(state);
    const cases = [
      [[{ add: { code: 'Code', type: 'SINGLE_LINE_TEXT', label: 'x' } }], /既に/, 0],
      [[{ label: { code: 'Nope', label: 'x' } }], /ありません/, 0],
      [[{ label: { code: 'Name', label: 'ok' } }, { lookup: { code: 'Mat', relatedApp: 77, relatedKeyField: 'name', fieldMappings: [] } }], /GAIA_LO03/, 1],
      [[{ lookup: { code: 'Mat', relatedApp: 77, relatedKeyField: 'zzz', fieldMappings: [] } }], /zzz/, 0],
      [[{ lookup: { code: 'Mat', relatedApp: 77, relatedKeyField: 'code', fieldMappings: [{ field: 'Name', relatedField: 'nope' }] } }], /nope/, 0],
      [[{ lookup: { code: 'Table', relatedApp: 77, relatedKeyField: 'code', fieldMappings: [] } }], /ルックアップにできません/, 0],
      [[{ add: { code: 'D', type: 'WHAT', label: 'x' } }], /型/, 0],
      [[{ layoutRow: { fields: ['Table'] } }], /まとめられません/, 0],
      [[{ foo: 1 }], /どれか/, 0],
    ];
    for (const [ops, re, index] of cases) {
      const r = await run(['form-change', '5', '--ops', writeOps(workDir, ops), '--plan']);
      assert.equal(r.code, 2, JSON.stringify(ops));
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error.code, 'bad_ops');
      assert.match(r.json.error.message, re);
      assert.equal(r.json.error.index, index);
      assert.equal('plan' in r.json, false);
    }
    // RECORD_NUMBER はキーにできる。参照先を読めない時は警告
    const ok = await run(['form-change', '5', '--ops', writeOps(workDir, [
      { lookup: { code: 'Mat', relatedApp: 77, relatedKeyField: 'rn', fieldMappings: [] } },
      { lookup: { code: 'Name', relatedApp: { code: 'MATS' }, relatedKeyField: 'code', fieldMappings: [] } },
    ]), '--plan']);
    assert.equal(ok.json.ok, true, ok.stdout);
    assert.equal(ok.json.warnings.length, 1);
    assert.equal(state.formWrites.length, 0);
  });
});

test('form-change: 削除とルックアップの解除は not_supported(どの op の位置でも・何も書かない)', async () => {
  await withPluginDir('kin-fc-nosup-', async ({ state, workDir, run }) => {
    formChangeState(state);
    for (const bad of [{ delete: { code: 'Name' } }, { lookup: null }, { deleteField: 'Name' }]) {
      for (const flags of [['--plan'], []]) {
        const r = await run(['form-change', '5', '--ops', writeOps(workDir, [{ label: { code: 'Name', label: 'x' } }, bad]), ...flags]);
        assert.equal(r.code, 2);
        assert.equal(r.json.error.code, 'not_supported');
        assert.match(r.json.error.message, /削除とルックアップの解除はしません/);
      }
    }
    assert.equal(state.formWrites.length, 0);
    assert.equal(state.deployPostCalls, 0);
  });
});

test('form-change: 実行は控え(form-<時刻>.json・600)→ preview → deploy。レイアウトは欄を抜いて新しい行を末尾に足す', async () => {
  await withPluginDir('kin-fc-apply-', async ({ state, workDir, backupDir, run }) => {
    formChangeState(state);
    const ops = writeOps(workDir, [
      { add: { code: 'Kind', type: 'DROP_DOWN', label: '区分', options: ['A', 'B'], required: true } },
      { label: { code: 'Name', label: '名称' } },
      { lookup: { code: 'Mat', relatedApp: 77, relatedKeyField: 'code', fieldMappings: [{ field: 'Name', relatedField: 'name' }], lookupPickerFields: ['code'] } },
      { layoutRow: { fields: ['Mat', 'Name'] } },
    ]);
    const r = await run(['form-change', '5', '--ops', ops]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mode, 'dev');
    assert.deepEqual(r.json.applied.map((a) => [a.i, a.op, a.code, a.ok]), [[0, 'add', 'Kind', true], [1, 'label', 'Name', true], [2, 'lookup', 'Mat', true], [3, 'layoutRow', 'Mat,Name', true]]);
    assert.equal(typeof r.json.seconds, 'number');

    // 控え
    assert.match(r.json.backup, /\/5\/form-.*\.json$/);
    assert.equal(statSync(r.json.backup).mode & 0o777, 0o600);
    const b = JSON.parse(readFileSync(r.json.backup, 'utf8'));
    assert.equal(b.kind, 'form');
    assert.ok(b.properties.Code && Array.isArray(b.layout));
    assert.ok(!JSON.stringify(b).includes(SECRET_PASSWORD));

    // preview への書き込み
    const [w0, w1, w2] = state.formWrites;
    assert.equal(w0.method, 'POST');
    assert.deepEqual(w0.body.properties.Kind.options, { A: { label: 'A', index: '0' }, B: { label: 'B', index: '1' } });
    assert.equal(w1.method, 'PUT');
    assert.deepEqual(w1.body.properties.Name, { type: 'SINGLE_LINE_TEXT', code: 'Name', label: '名称' });
    assert.deepEqual(w2.body.properties.Mat.lookup, {
      relatedApp: { app: '77' }, relatedKeyField: 'code', fieldMappings: [{ field: 'Name', relatedField: 'name' }], lookupPickerFields: ['code'],
    });
    assert.equal(w2.body.properties.Mat.type, 'SINGLE_LINE_TEXT', 'type は今の型のまま');
    assert.deepEqual(state.layoutPutCalls[0].layout, [
      { type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'Code' }] },
      { type: 'SUBTABLE', code: 'Table', fields: [{ type: 'NUMBER', code: 'Qty' }] },
      { type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'Mat' }, { type: 'SINGLE_LINE_TEXT', code: 'Name', size: { width: '200' } }] },
    ]);
    assert.equal(state.deployPostCalls, 1);
    assert.deepEqual(state.deployBodies[0], { apps: [{ app: '5' }] });

    // 控えは undo の対象にならず、backups には kind:form で出る
    const list = await run(['backups', '5']);
    assert.equal(list.json.backups[0].kind, 'form');
    const undo = await run(['undo', '5']);
    assert.match(undo.json.error ? undo.json.error.message : '', /控えがありません/);
  });
});

test('form-change: 途中で失敗したら残りはやらず、deploy もしない(error に何番目か)', async () => {
  await withPluginDir('kin-fc-fail-', async ({ state, workDir, run }) => {
    formChangeState(state);
    state.failFormPut = true;
    const ops = writeOps(workDir, [
      { add: { code: 'K1', type: 'NUMBER', label: 'k' } },
      { label: { code: 'Name', label: 'x' } },
    ]);
    const r = await run(['form-change', '5', '--ops', ops]);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.deepEqual(r.json.applied.map((a) => [a.i, a.ok]), [[0, false]]);
    assert.equal(r.json.error.index, 0);
    assert.equal(r.json.error.step, 'op');
    assert.ok(r.json.backup);
    assert.equal(state.formWrites.length, 1, '2つ目はやらない');
    assert.equal(state.deployPostCalls, 0);
  });
});

test('form-change: 本番は実行が prod_denied(何も書かない)・--plan は通る', async () => {
  await withPluginDir('kin-fc-prod-', async ({ state, workDir, backupDir, run }) => {
    formChangeState(state);
    const ops = writeOps(workDir, [{ label: { code: 'Name', label: 'x' } }]);
    const r = await run(['form-change', '42', '--ops', ops]);
    assert.equal(r.code, 2);
    assert.equal(r.json.error.code, 'prod_denied');
    assert.match(r.json.error.message, /本番では/);
    assert.equal(state.formWrites.length, 0);
    assert.equal(readdirSync(backupDir).length, 0);
    const p = await run(['form-change', '42', '--ops', ops, '--plan']);
    assert.equal(p.json.ok, true);
    assert.equal(p.json.mode, 'prod');
  }, ['KINTONE_PROD_HOST=127.0.0.1', 'KINTONE_PROD_APPS=42']);
});

test('form-change: 引数が足りなければ使い方を返す', async () => {
  await withPluginDir('kin-fc-usage-', async ({ run }) => {
    const r = await run(['form-change', '5']);
    assert.equal(r.code, 2);
    assert.match(r.json.error.message, /使い方: form-change/);
  });
});
