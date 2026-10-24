import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from '../tools/kin-env.mjs';

const CLI = fileURLToPath(new URL('../tools/kin-profile.mjs', import.meta.url));
const PW = 'S3cret-pw!XYZ';
let server, probeBase, probeCode = 401, root, base;

before(async () => {
  server = createServer((req, res) => { res.statusCode = probeCode; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  probeBase = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kin-prof-'));
  base = join(root, 'cfg');
  probeCode = 401;
});

// 非同期の spawn(同期だとテスト内のモックサーバーが応答できない)
function cli(args, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, KINTONE_ROOM_CONFIG_DIR: base, RELAY_PROBE_BASE: probeBase },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err, json: JSON.parse(out) }));
    p.stdin.end(input ?? '');
  });
}
const save = (o, a = []) => cli(['save', ...a], JSON.stringify(o));
const dev = { name: '開発', subdomain: 'my-dev', domain: 'cybozu.com', username: 'admin', password: PW, kind: 'dev', apps: '' };
const mode = (p) => statSync(p).mode & 0o777;
const noPw = (r) => assert.ok(!r.out.includes(PW) && !r.err.includes(PW), 'パスワードが出力に出ている');

test('save: 600・700・キー・名前行・probe 401', async () => {
  const r = await save(dev);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.id, 'my-dev');
  assert.equal(r.json.active, false);
  assert.equal(r.json.synced, false);
  assert.match(r.json.hint, /保存だけでは接続先は変わりません。\/kin use my-dev で切り替えます/);
  assert.equal(r.json.check.probe.code, 401);
  assert.equal(r.json.check.probe.message, '環境は生きています');
  assert.equal(r.json.check.status.ok, true);
  assert.equal(r.json.check.status.mode, 'dev');
  const f = join(base, 'kintone', 'my-dev.env');
  assert.equal(mode(f), 0o600);
  assert.equal(mode(join(base, 'kintone')), 0o700);
  const t = readFileSync(f, 'utf8');
  assert.equal(t.split('\n')[0], '# name: 開発');
  assert.deepEqual(parseEnv(t), {
    KINTONE_BASE_URL: 'https://my-dev.cybozu.com', KINTONE_USERNAME: 'admin', KINTONE_PASSWORD: PW,
    KINTONE_DEV_HOSTS: 'my-dev.cybozu.com',
  });
  assert.ok(!readdirSync(join(base, 'kintone')).some((n) => n.startsWith('.tmp-')));
  noPw(r);
});

test('probe 404 と その他コード', async () => {
  probeCode = 404;
  assert.equal((await save(dev)).json.check.probe.message, 'サブドメインの打ち間違いかも');
  probeCode = 503;
  const r = await save({ ...dev, id: 'my-dev' });
  assert.equal(r.json.check.probe.code, 503);
});

test('list: パスワードを返さず passwordSet だけ。api.py 形式のファイルを読める', async () => {
  mkdirSync(join(base, 'kintone'), { recursive: true, mode: 0o700 });
  // api.py _build が書く形(prod・引用符つきパスワード)
  writeFileSync(join(base, 'kintone', 'honban.env'),
    `# name: 本番お試し\nKINTONE_BASE_URL=https://corp.kintone.com\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=" pw with space "\nKINTONE_PROD_HOST=corp.kintone.com\nKINTONE_PROD_APPS=42,97\n`, { mode: 0o600 });
  const r = await cli(['list']);
  const it = r.json.items.find((x) => x.id === 'honban');
  assert.deepEqual(
    { name: it.name, host: it.host, domain: it.domain, kind: it.kind, apps: it.apps, passwordSet: it.passwordSet, active: it.active },
    { name: '本番お試し', host: 'corp.kintone.com', domain: 'kintone.com', kind: 'prod', apps: '42,97', passwordSet: true, active: false });
  assert.ok(!r.out.includes('pw with space'));
});

test('逆方向: この mod が書いた形は api.py と同じ並び・引用規則', async () => {
  await save({ ...dev, password: ' sp ace ', id: 'q1' });
  const t = readFileSync(join(base, 'kintone', 'q1.env'), 'utf8');
  assert.equal(t, '# name: 開発\nKINTONE_BASE_URL=https://my-dev.cybozu.com\nKINTONE_USERNAME=admin\nKINTONE_PASSWORD=\' sp ace \'\nKINTONE_DEV_HOSTS=my-dev.cybozu.com\n');
  assert.equal(parseEnv(t).KINTONE_PASSWORD, ' sp ace ');
  await save({ name: '本番', subdomain: 'https://Corp.kintone.com/k/', domain: 'cybozu.com', username: 'u', password: PW, kind: 'prod', apps: '42, 97' });
  const p = readFileSync(join(base, 'kintone', 'corp.env'), 'utf8');
  assert.equal(p, `# name: 本番\nKINTONE_BASE_URL=https://corp.kintone.com\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=${PW}\nKINTONE_PROD_HOST=corp.kintone.com\nKINTONE_PROD_APPS=42,97\n`);
});

test('cybozu.cn と kintone.com のドメイン選択', async () => {
  const r = await save({ ...dev, subdomain: 'cn-sub', domain: 'cybozu.cn' });
  assert.equal(r.json.id, 'cn-sub');
  assert.match(readFileSync(join(base, 'kintone', 'cn-sub.env'), 'utf8'), /https:\/\/cn-sub\.cybozu\.cn/);
  const bad = await save({ ...dev, subdomain: 'x.example.com' });
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.error.code, 'invalid');
});

test('空パスワードは既存を保ち、新規は必須', async () => {
  await save({ ...dev, id: 'a1' });
  const r = await save({ ...dev, id: 'a1', name: '改名', password: '' });
  assert.equal(r.json.ok, true);
  assert.equal(parseEnv(readFileSync(join(base, 'kintone', 'a1.env'), 'utf8')).KINTONE_PASSWORD, PW);
  assert.match(readFileSync(join(base, 'kintone', 'a1.env'), 'utf8'), /^# name: 改名/);
  const n = await save({ ...dev, id: 'brand-new', password: '' });
  assert.equal(n.json.ok, false);
  assert.ok(!existsSync(join(base, 'kintone', 'brand-new.env')));
});

test('本番はアプリ番号必須・数字のみ', async () => {
  const p = { ...dev, kind: 'prod', apps: '' };
  assert.equal((await save(p)).json.ok, false);
  const r = await save({ ...p, apps: '12,ab' });
  assert.equal(r.json.ok, false);
  assert.equal((await save({ ...p, apps: '12' })).json.ok, true);
});

test('ID のパス走査は拒否', async () => {
  for (const id of ['../x', 'a/b', 'A', '', 'x'.repeat(33)]) {
    if (id === '') continue; // 空は自動採番
    const r = await save({ ...dev, id });
    assert.equal(r.json.ok, false, id);
  }
  assert.equal((await cli(['use', '../../etc/passwd'])).json.ok, false);
  assert.equal((await cli(['delete', '../x'])).json.ok, false);
  assert.ok(!existsSync(join(root, 'x.env')));
});

test('use: kintone.env に 600 で写し(名前行なし)、active を書く。本番は mode:prod', async () => {
  await save({ ...dev, id: 'd1' });
  await save({ name: '本番', subdomain: 'corp', domain: 'kintone.com', username: 'u', password: PW, kind: 'prod', apps: '5', id: 'p1' });
  const r = await cli(['use', 'p1']);
  assert.deepEqual(r.json, { ok: true, id: 'p1', mode: 'prod', host: 'corp.kintone.com' });
  assert.equal(mode(join(base, 'kintone.env')), 0o600);
  const t = readFileSync(join(base, 'kintone.env'), 'utf8');
  assert.ok(!t.includes('# name:'));
  assert.equal(parseEnv(t).KINTONE_PROD_APPS, '5');
  assert.equal(readFileSync(join(base, 'kintone', 'active'), 'utf8'), 'p1\n');
  noPw(r);
  assert.equal((await cli(['use', 'nope'])).json.ok, false);
});

test('使用中への save は kintone.env に同期(synced:true・hint なし)', async () => {
  await save({ ...dev, id: 'd1' });
  await cli(['use', 'd1']);
  const r = await save({ ...dev, id: 'd1', username: 'admin2', password: '' });
  assert.equal(r.json.synced, true);
  assert.equal(r.json.active, true);
  assert.equal(r.json.hint, undefined);
  const e = parseEnv(readFileSync(join(base, 'kintone.env'), 'utf8'));
  assert.equal(e.KINTONE_USERNAME, 'admin2');
  assert.equal(e.KINTONE_PASSWORD, PW);
  assert.equal(mode(join(base, 'kintone.env')), 0o600);
});

test('移行: 既存 kintone.env は dev として取り込まれ active になる(一致すれば重複しない)', async () => {
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'kintone.env'),
    `KINTONE_BASE_URL=https://old-dev.cybozu.com\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=${PW}\nKINTONE_DEV_HOSTS=old-dev.cybozu.com\n`, { mode: 0o600 });
  const r = await cli(['list']);
  assert.equal(r.json.active, 'dev');
  assert.equal(r.json.items.length, 1);
  assert.equal(r.json.items[0].name, '開発環境');
  assert.equal(r.json.items[0].active, true);
  assert.equal(readFileSync(join(base, 'kintone', 'dev.env'), 'utf8').split('\n')[0], '# name: 開発環境');
  const r2 = await cli(['list']);
  assert.equal(r2.json.items.length, 1);
  noPw(r);
});

test('status: 接続先・件数。パスワードは出ない', async () => {
  await save({ ...dev, id: 'd1' });
  await cli(['use', 'd1']);
  const r = await cli(['status']);
  assert.deepEqual(r.json, { ok: true, active: 'd1', name: '開発', host: 'my-dev.cybozu.com', mode: 'dev', prodApps: [], profiles: 1 });
  noPw(r);
});

test('status: kintone.env が無ければ missing と /kin setup の案内', async () => {
  const r = await cli(['status']);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'missing');
  assert.match(r.json.error.message, /\/kin setup/);
  assert.equal(r.code, 1);
});

test('delete: 使用中は拒否、それ以外は削除', async () => {
  await save({ ...dev, id: 'd1' });
  await save({ ...dev, id: 'd2' });
  await cli(['use', 'd1']);
  assert.equal((await cli(['delete', 'd1'])).json.ok, false);
  assert.ok(existsSync(join(base, 'kintone', 'd1.env')));
  assert.equal((await cli(['delete', 'd2'])).json.ok, true);
  assert.ok(!existsSync(join(base, 'kintone', 'd2.env')));
});

test('save --stdin-file の正常系', async () => {
  const f = join(root, 'in2.json');
  writeFileSync(f, JSON.stringify(dev));
  const r = await cli(['save', '--stdin-file', f]);
  assert.equal(r.json.ok, true);
  assert.ok(!existsSync(f));
  noPw(r);
});

test('不正な入力でもパスワードを出さない', async () => {
  const r = await cli(['save'], '{"password":"' + PW + '", broken');
  assert.equal(r.json.ok, false);
  noPw(r);
  const r2 = await save({ ...dev, password: PW + '\nX=1' });
  assert.equal(r2.json.ok, false);
  noPw(r2);
});

test('status の不正な env でもパスワードを出さない(権限が緩い)', async () => {
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'kintone.env'),
    `KINTONE_BASE_URL=https://a.cybozu.com\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=${PW}\nKINTONE_DEV_HOSTS=a.cybozu.com\n`);
  chmodSync(join(base, 'kintone.env'), 0o644);
  const r = await cli(['status']);
  assert.equal(r.json.ok, false);
  noPw(r);
});
