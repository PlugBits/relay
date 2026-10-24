// tools/kin-records.mjs のテスト。node:http のモック kintone と一時ディレクトリだけを使う。
// 実行: node --test test/kin-records.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'kin-records.mjs');
const SECRET = 'S3cr3t-P@ssw0rd-do-not-leak';

async function startMock(state) {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      state.calls.push(`${req.method} ${u.pathname}`);
      if (u.pathname === '/k/v1/records.json' && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        state.posted.push(body);
        const ids = body.records.map(() => String(state.nextId++));
        ids.forEach((i) => state.alive.add(i));
        return send(200, { ids, revisions: ids.map(() => '1') });
      }
      if (u.pathname === '/k/v1/records.json' && req.method === 'DELETE') {
        const ids = [...u.searchParams.entries()].filter(([k]) => k.startsWith('ids[')).map(([, v]) => v);
        state.deleteBatches.push(ids);
        if (ids.some((i) => !state.alive.has(i))) {
          return send(404, { code: 'GAIA_RE01', message: '指定したレコードが見つかりません' });
        }
        ids.forEach((i) => state.alive.delete(i));
        return send(200, {});
      }
      send(404, { code: 'MOCK', message: 'no route' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function newState() {
  return { calls: [], posted: [], deleteBatches: [], alive: new Set(), nextId: 100 };
}

function setup(baseUrl, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'kin-records-'));
  const envFile = join(dir, 'kintone.env');
  writeFileSync(envFile, [`KINTONE_BASE_URL=${baseUrl}`, 'KINTONE_USERNAME=admin', `KINTONE_PASSWORD=${SECRET}`, ...extra, ''].join('\n'));
  chmodSync(envFile, 0o600);
  const backup = join(dir, 'backup');
  const rowsFile = join(dir, 'rows.json');
  return { dir, envFile, backup, rowsFile };
}

function runCli(args, { envFile, backup }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, KIN_ENV_FILE: envFile, KIN_ALLOW_LOCAL: '1', KIN_BACKUP_DIR: backup },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      let json;
      try { json = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()); } catch { /* 無し */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}

test('write: {value} に包んで POST し、id を 700/600 で記録。list と cleanup(tag 指定)', async () => {
  const state = newState();
  const mock = await startMock(state);
  const s = setup(mock.baseUrl);
  try {
    writeFileSync(s.rowsFile, JSON.stringify([{ 品番: 'ZZ-1', 数量: 3, 複数: ['a', 'b'] }, { 品番: 'ZZ-2' }]));
    const w = await runCli(['write', '5', '--rows', s.rowsFile, '--tag', 'run-1'], s);
    assert.equal(w.code, 0, w.stderr);
    assert.equal(w.json.ok, true);
    assert.equal(w.json.mode, 'dev');
    assert.deepEqual(w.json.ids, ['100', '101']);
    assert.deepEqual(state.posted[0].records[0], { 品番: { value: 'ZZ-1' }, 数量: { value: 3 }, 複数: { value: ['a', 'b'] } });
    assert.equal(state.posted[0].app, '5');
    assert.ok(w.json.file.endsWith(join('5', 'test-records.json')));
    assert.equal(statSync(w.json.file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(w.json.file)).mode & 0o777, 0o700);
    const saved = JSON.parse(readFileSync(w.json.file, 'utf8'));
    assert.deepEqual(saved.items.map((i) => [i.id, i.tag]), [['100', 'run-1'], ['101', 'run-1']]);
    assert.ok(saved.items[0].at);

    writeFileSync(s.rowsFile, JSON.stringify([{ 品番: 'Y' }]));
    await runCli(['write', '5', '--rows', s.rowsFile, '--tag', 'other'], s);

    const l = await runCli(['list', '5'], s);
    assert.deepEqual(l.json, { ok: true, appId: '5', count: 3, tags: { 'run-1': 2, other: 1 } });

    const c = await runCli(['cleanup', '5', '--tag', 'run-1'], s);
    assert.deepEqual(c.json, { ok: true, appId: '5', deleted: 2, missing: 0, remaining: 1 });
    assert.deepEqual(state.deleteBatches, [['100', '101']]);
    assert.deepEqual([...state.alive], ['102']);

    const c2 = await runCli(['cleanup', '5'], s);
    assert.deepEqual(c2.json, { ok: true, appId: '5', deleted: 1, missing: 0, remaining: 0 });
    for (const r of [w, l, c, c2]) assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  } finally {
    await mock.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('cleanup: 既に無い id は 1 件ずつ消して missing に数え、記録から外す。記録に無い id は触らない', async () => {
  const state = newState();
  const mock = await startMock(state);
  const s = setup(mock.baseUrl);
  try {
    writeFileSync(s.rowsFile, JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]));
    await runCli(['write', '7', '--rows', s.rowsFile, '--tag', 't'], s);
    state.alive.delete('101'); // 人が画面で消した
    state.alive.add('999'); // 記録に無いレコード
    const c = await runCli(['cleanup', '7'], s);
    assert.deepEqual(c.json, { ok: true, appId: '7', deleted: 2, missing: 1, remaining: 0 });
    assert.deepEqual([...state.alive], ['999']);
    assert.ok(!state.deleteBatches.flat().includes('999'));
  } finally {
    await mock.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('cleanup: 100 件ずつ送る', async () => {
  const state = newState();
  const mock = await startMock(state);
  const s = setup(mock.baseUrl);
  try {
    writeFileSync(s.rowsFile, JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ a: i }))));
    // 20 行 × 6 回 = 120 件
    for (let i = 0; i < 6; i++) await runCli(['write', '8', '--rows', s.rowsFile, '--tag', 'big'], s);
    const c = await runCli(['cleanup', '8', '--tag', 'big'], s);
    assert.equal(c.json.deleted, 120);
    assert.deepEqual(state.deleteBatches.map((b) => b.length), [100, 20]);
  } finally {
    await mock.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('入力の検査: 21 行・tag 不正・rows 無し・appId 不正', async () => {
  const state = newState();
  const mock = await startMock(state);
  const s = setup(mock.baseUrl);
  try {
    writeFileSync(s.rowsFile, JSON.stringify(Array.from({ length: 21 }, () => ({ a: 1 }))));
    const many = await runCli(['write', '5', '--rows', s.rowsFile, '--tag', 'x'], s);
    assert.equal(many.code, 2);
    assert.equal(many.json.error.code, 'too_many_rows');
    writeFileSync(s.rowsFile, JSON.stringify([{ a: 1 }]));
    const badTag = await runCli(['write', '5', '--rows', s.rowsFile, '--tag', 'bad tag!'], s);
    assert.equal(badTag.json.error.code, 'bad_input');
    const noTag = await runCli(['write', '5', '--rows', s.rowsFile], s);
    assert.equal(noTag.json.error.code, 'bad_input');
    const noRows = await runCli(['write', '5', '--tag', 'x'], s);
    assert.equal(noRows.json.error.code, 'bad_input');
    const badApp = await runCli(['list', 'abc'], s);
    assert.equal(badApp.json.error.code, 'bad_input');
    const noApp = await runCli(['list'], s);
    assert.equal(noApp.code, 2);
    assert.equal(state.calls.length, 0);
    assert.equal((await runCli(['bogus'], s)).code, 2);
  } finally {
    await mock.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('本番: write/cleanup は通信前に prod_denied、list は通信せず読める', async () => {
  const state = newState();
  const mock = await startMock(state);
  const host = new URL(mock.baseUrl).hostname;
  const s = setup(mock.baseUrl, [`KINTONE_PROD_HOST=${host}`]);
  try {
    writeFileSync(s.rowsFile, JSON.stringify([{ a: 1 }]));
    const w = await runCli(['write', '5', '--rows', s.rowsFile, '--tag', 'x'], s);
    assert.equal(w.code, 2);
    assert.equal(w.json.ok, false);
    assert.equal(w.json.error.code, 'prod_denied');
    assert.match(w.json.error.message, /本番では/);
    const c = await runCli(['cleanup', '5'], s);
    assert.equal(c.json.error.code, 'prod_denied');
    const l = await runCli(['list', '5'], s);
    assert.deepEqual(l.json, { ok: true, appId: '5', count: 0, tags: {} });
    assert.equal(state.calls.length, 0);
    assert.ok(!existsSync(s.backup));
  } finally {
    await mock.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('env ファイルが無いと missing で exit 2', async () => {
  const s = setup('http://127.0.0.1:1');
  try {
    const r = await runCli(['list', '5'], { envFile: join(s.dir, 'nope.env'), backup: s.backup });
    assert.equal(r.code, 2);
    assert.equal(r.json.error.code, 'missing');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
