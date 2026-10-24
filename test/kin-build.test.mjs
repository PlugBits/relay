import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../tools/kin-build.mjs', import.meta.url));
const roots = [];
let root, pdir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kin-build-'));
  roots.push(root);
  pdir = join(root, 'plugins', 'x');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'manifest.json'), '{"manifest_version":1}');
});
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function cfg(build, extra = {}) {
  writeFileSync(join(pdir, 'relay.config.json'), JSON.stringify({ ...extra, ...(build === undefined ? {} : { build }) }));
}

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      const last = out.trim().split('\n').pop();
      resolve({ code, out, err, json: JSON.parse(last) });
    });
  });
}

const OK_CMD = 'mkdir -p plugins/x-dev && cp plugins/x/manifest.json plugins/x-dev/';

test('build が無い → built:false', async () => {
  cfg(undefined, { foo: 1 });
  const r = await cli([pdir]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { ok: true, built: false, dir: pdir });
});

test('relay.config.json 自体が無くても built:false', async () => {
  const r = await cli([pdir]);
  assert.equal(r.json.built, false);
});

test('--check は実行しない', async () => {
  cfg({ command: OK_CMD, dir: 'plugins/x-dev' });
  const r = await cli([pdir, '--check']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { ok: true, build: { command: OK_CMD, dir: join(root, 'plugins', 'x-dev') } });
  assert.equal(existsSync(join(root, 'plugins', 'x-dev')), false);
});

test('--check で build 無しは build:null', async () => {
  cfg(undefined);
  const r = await cli([pdir, '--check']);
  assert.deepEqual(r.json, { ok: true, build: null });
});

test('成功: 根で実行され manifest を確認', async () => {
  cfg({ command: `echo hello; ${OK_CMD}`, dir: 'plugins/x-dev' });
  const r = await cli([pdir]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.built, true);
  assert.equal(r.json.dir, join(root, 'plugins', 'x-dev'));
  assert.equal(typeof r.json.seconds, 'number');
  assert.match(r.json.tail, /hello/);
  assert.ok(existsSync(join(root, 'plugins', 'x-dev', 'manifest.json')));
});

test('tail は末尾 20 行・stderr も含む', async () => {
  cfg({ command: `seq 1 50; echo oops >&2; ${OK_CMD}`, dir: 'plugins/x-dev' });
  const r = await cli([pdir]);
  const lines = r.json.tail.split('\n');
  assert.equal(lines.length, 20);
  assert.equal(lines.at(-1), 'oops');
  assert.equal(lines[0], '32');
});

test('失敗 → build_failed + tail', async () => {
  cfg({ command: 'echo boom; exit 3', dir: 'plugins/x-dev' });
  const r = await cli([pdir]);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'build_failed');
  assert.match(r.json.error.tail, /boom/);
  assert.match(r.json.error.message, /3/);
});

test('manifest 無し → no_manifest', async () => {
  cfg({ command: 'mkdir -p plugins/x-dev', dir: 'plugins/x-dev' });
  const r = await cli([pdir]);
  assert.equal(r.json.error.code, 'no_manifest');
});

test('タイムアウトで止める(子プロセスも)', async () => {
  const marker = join(root, 'late.txt');
  cfg({ command: `sleep 5 && touch ${marker}`, dir: 'plugins/x-dev' });
  const t0 = Date.now();
  const r = await cli([pdir], { RELAY_BUILD_TIMEOUT_MS: '300' });
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(r.json.error.code, 'build_failed');
  assert.match(r.json.error.message, /終わらず/);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(existsSync(marker), false);
});

for (const [name, dir] of [
  ['.. で外へ', 'plugins/../../evil'],
  ['plugins の外', 'other/x-dev'],
  ['絶対パスで外', '/tmp'],
  ['plugins 自体', 'plugins'],
]) {
  test(`dir が外 (${name}) → bad_config・実行しない`, async () => {
    const marker = join(root, 'ran.txt');
    cfg({ command: `touch ${marker}`, dir });
    const r = await cli([pdir]);
    assert.equal(r.json.error.code, 'bad_config');
    assert.equal(existsSync(marker), false);
  });
}

test('シンボリックリンクで外へ → bad_config', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'kin-build-out-'));
  roots.push(outside);
  writeFileSync(join(outside, 'manifest.json'), '{}');
  symlinkSync(outside, join(root, 'plugins', 'link'));
  const marker = join(root, 'ran.txt');
  cfg({ command: `touch ${marker}`, dir: 'plugins/link' });
  const r = await cli([pdir]);
  assert.equal(r.json.error.code, 'bad_config');
  assert.equal(existsSync(marker), false);
});

for (const [name, build] of [
  ['command が数値', { command: 5, dir: 'plugins/x-dev' }],
  ['command が空', { command: '', dir: 'plugins/x-dev' }],
  ['command が 401 字', { command: 'a'.repeat(401), dir: 'plugins/x-dev' }],
  ['dir が無い', { command: 'true' }],
  ['dir が数値', { command: 'true', dir: 1 }],
  ['build が文字列', 'make'],
  ['build が配列', []],
]) {
  test(`型が違う (${name}) → bad_config`, async () => {
    cfg(build);
    const r = await cli([pdir]);
    assert.equal(r.json.error.code, 'bad_config');
  });
}

test('壊れた JSON → bad_config', async () => {
  writeFileSync(join(pdir, 'relay.config.json'), '{nope');
  const r = await cli([pdir]);
  assert.equal(r.json.error.code, 'bad_config');
});

test('引数無し → exit 2', async () => {
  const r = await cli([]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
});

test('env の値を出さない', async () => {
  cfg({ command: `${OK_CMD}`, dir: 'plugins/x-dev' });
  const r = await cli([pdir], { KINTONE_PASSWORD: 'S3cret-pw!XYZ' });
  assert.ok(!r.out.includes('S3cret-pw!XYZ') && !r.err.includes('S3cret-pw!XYZ'));
});
