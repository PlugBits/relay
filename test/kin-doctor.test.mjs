import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../tools/kin-doctor.mjs', import.meta.url));
let server, probeBase, code = 401;
before(async () => {
  server = createServer((req, res) => { res.statusCode = code; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  probeBase = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function doctor(env = {}, withConn = true) {
  const base = mkdtempSync(join(tmpdir(), 'kin-doc-'));
  if (withConn) {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'kintone.env'),
      'KINTONE_BASE_URL=https://doc-dev.cybozu.com\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=Pw-doc-123\nKINTONE_DEV_HOSTS=doc-dev.cybozu.com\n', { mode: 0o600 });
  }
  return new Promise((resolve) => {
    const e = { ...process.env, KINTONE_ROOM_CONFIG_DIR: base, RELAY_PROBE_BASE: probeBase, ...env };
    delete e.RELAY_NATIVE_LIBS_UNSET;
    if (!('RELAY_NATIVE_LIBS' in env)) delete e.RELAY_NATIVE_LIBS;
    if (!('RELAY_CHROMIUM' in env)) delete e.RELAY_CHROMIUM;
    const p = spawn(process.execPath, [CLI], { env: e });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (c) => resolve({ c, out, json: JSON.parse(out) }));
  });
}
const by = (r, n) => r.json.checks.find((c) => c.name === n);

test('chromium が無い(RELAY_CHROMIUM が存在しない)→ 警告・全体は ok', async () => {
  const r = await doctor({ RELAY_CHROMIUM: '/nonexistent/chrome' });
  const c = by(r, 'chromium');
  assert.equal(c.ok, false);
  assert.equal(c.warn, true);
  assert.equal(c.fix, '画面チェックを使うなら: npx playwright install chromium(この mod は自動では入れません)');
  assert.equal(by(r, 'node').ok, true);
  assert.equal(by(r, 'connection').ok, true);
  assert.equal(by(r, 'reachable').ok, true);
  assert.equal(r.json.ok, true);
  assert.equal(r.c, 0);
  assert.ok(!r.out.includes('Pw-doc-123'));
});

test('RELAY_CHROMIUM が実在すれば chromium は ok', async () => {
  const r = await doctor({ RELAY_CHROMIUM: process.execPath });
  assert.equal(by(r, 'chromium').ok, true);
  assert.equal(by(r, 'chromium').fix, undefined);
});

test('RELAY_NATIVE_LIBS: 無い dir は警告、あれば ok、未設定なら項目なし', async () => {
  const missing = await doctor({ RELAY_NATIVE_LIBS: '/nonexistent/libs', RELAY_CHROMIUM: process.execPath });
  assert.equal(by(missing, 'native-libs').ok, false);
  assert.equal(missing.json.ok, true);
  const present = await doctor({ RELAY_NATIVE_LIBS: tmpdir(), RELAY_CHROMIUM: process.execPath });
  assert.equal(by(present, 'native-libs').ok, true);
  assert.equal(by(await doctor({}), 'native-libs'), undefined);
});

test('接続先が無ければ全体 NG(fix は /kin setup)', async () => {
  const r = await doctor({ RELAY_CHROMIUM: process.execPath }, false);
  assert.equal(by(r, 'connection').ok, false);
  assert.match(by(r, 'connection').fix, /\/kin setup/);
  assert.equal(r.json.ok, false);
  assert.equal(r.c, 1);
});

test('probe が 404 なら reachable NG、401 なら ok', async () => {
  code = 404;
  const r = await doctor({ RELAY_CHROMIUM: process.execPath });
  code = 401;
  assert.equal(by(r, 'reachable').ok, false);
  assert.equal(r.json.ok, false);
  assert.equal(by(await doctor({ RELAY_CHROMIUM: process.execPath }), 'reachable').ok, true);
});
