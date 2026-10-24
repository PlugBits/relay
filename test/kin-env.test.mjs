import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAllowedHost, isProdHost, assertAppAllowed, loadKinEnv, parseEnv, authHeaders, SETUP_HINT } from '../tools/kin-env.mjs';

function envFile(body, mode = 0o600) {
  const f = join(mkdtempSync(join(tmpdir(), 'kin-env-')), 'kintone.env');
  writeFileSync(f, body);
  chmodSync(f, mode);
  return f;
}

test('許可リスト: plugbits を含む開発環境だけ通す', () => {
  assert.equal(isAllowedHost('https://plugbits-dev.cybozu.com'), true);
  assert.equal(isAllowedHost('https://example.cybozu.com'), false);
  assert.equal(isAllowedHost('https://example.cybozu.com', ['example.cybozu.com']), true);
  assert.equal(isAllowedHost('http://plugbits-dev.cybozu.com'), false);
  assert.equal(isAllowedHost('https://plugbits.cybozu.com.evil.example'), false);
  assert.equal(isAllowedHost('http://127.0.0.1:9999'), false);
  assert.equal(isAllowedHost('http://127.0.0.1:9999', [], { local: true }), true);
  assert.equal(isAllowedHost('not a url'), false);
});

test('parseEnv: 引用符・export・コメント', () => {
  assert.deepEqual(parseEnv('# c\nexport A="1"\nB=\'x=y\'\n\nC=3'), { A: '1', B: 'x=y', C: '3' });
});

test('loadKinEnv: 無い・欠け・本番・権限・正常', () => {
  assert.throws(() => loadKinEnv({ file: '/nonexistent/kintone.env' }), { code: 'missing' });
  assert.throws(() => loadKinEnv({ file: envFile('KINTONE_BASE_URL=https://plugbits-dev.cybozu.com\n') }), { code: 'missing' });
  const prod = envFile('KINTONE_BASE_URL=https://example.cybozu.com\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=secret-pw\n');
  assert.throws(() => loadKinEnv({ file: prod }), (e) => e.code === 'denied' && !e.message.includes('secret-pw'));
  const open = envFile('KINTONE_BASE_URL=https://plugbits-dev.cybozu.com\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=p\n', 0o644);
  assert.throws(() => loadKinEnv({ file: open }), { code: 'perm' });
  const ok = envFile('KINTONE_BASE_URL=https://plugbits-dev.cybozu.com/\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=p\n');
  assert.deepEqual(loadKinEnv({ file: ok }), { baseUrl: 'https://plugbits-dev.cybozu.com', username: 'u', password: 'p', mode: 'dev', prodApps: [] });
});

test('authHeaders', () => {
  assert.deepEqual(authHeaders({ username: 'u', password: 'p' }), { 'X-Cybozu-Authorization': 'dTpw' });
});

test('PROD_HOST: 開発判定(plugbits / DEV_HOSTS)より優先して prod になる', () => {
  const head = 'KINTONE_USERNAME=u\nKINTONE_PASSWORD=p\n';
  const a = loadKinEnv({ file: envFile(`KINTONE_BASE_URL=https://plugbits-dev.cybozu.com\n${head}KINTONE_PROD_HOST=plugbits-dev.cybozu.com\nKINTONE_PROD_APPS=42, 97,\n`) });
  assert.equal(a.mode, 'prod');
  assert.deepEqual(a.prodApps, ['42', '97']);
  const b = loadKinEnv({ file: envFile(`KINTONE_BASE_URL=https://x.cybozu.com\n${head}KINTONE_DEV_HOSTS=x.cybozu.com\nKINTONE_PROD_HOST=X.cybozu.com\n`) });
  assert.equal(b.mode, 'prod');
  assert.deepEqual(b.prodApps, []);
  // PROD_HOST と違うホストは従来どおり dev / denied
  const c = loadKinEnv({ file: envFile(`KINTONE_BASE_URL=https://plugbits-dev.cybozu.com\n${head}KINTONE_PROD_HOST=other.cybozu.com\n`) });
  assert.equal(c.mode, 'dev');
  assert.throws(() => loadKinEnv({ file: envFile(`KINTONE_BASE_URL=https://y.cybozu.com\n${head}KINTONE_PROD_HOST=other.cybozu.com\nKINTONE_PROD_APPS=1\n`) }), { code: 'denied' });
  assert.equal(isProdHost('http://x.cybozu.com', 'x.cybozu.com'), false);
});

test('assertAppAllowed: prod は PROD_APPS だけ(番号入りの denied)・空は全拒否・dev は素通し', () => {
  assert.doesNotThrow(() => assertAppAllowed({ mode: 'dev', prodApps: [] }, '5'));
  assert.doesNotThrow(() => assertAppAllowed({ mode: 'prod', prodApps: ['42'] }, 42));
  assert.throws(() => assertAppAllowed({ mode: 'prod', prodApps: ['42'] }, '5'), (e) => e.code === 'denied' && e.message.includes('アプリ 5 '));
  assert.throws(() => assertAppAllowed({ mode: 'prod', prodApps: [] }, '42'), { code: 'denied' });
  assert.throws(() => assertAppAllowed({ mode: 'prod', prodApps: ['42'] }, '96abc'), { code: 'denied' });
});

test('SETUP_HINT: /kin setup を主、お試しアプリの注意と手書き形式を従で含む', () => {
  assert.match(SETUP_HINT.split('\n')[0], /\/kin setup で画面から入れられます/);
  assert.match(SETUP_HINT, /お試し用のアプリを1つ作ってから。既存のアプリには入れないでください/);
  assert.match(SETUP_HINT, /KINTONE_BASE_URL/);
  assert.match(SETUP_HINT, /KINTONE_PROD_HOST/);
  assert.match(SETUP_HINT, /KINTONE_PROD_APPS/);
});

test('米国版 kintone.com: 日本版 cybozu.com と同じく DEV_HOSTS / PROD_HOST で通る・それ以外のドメインは拒否', () => {
  for (const d of ['cybozu.com', 'kintone.com']) {
    const host = `acme.${d}`;
    assert.equal(isAllowedHost(`https://${host}`), false, `${d}: 未登録は本番扱いで拒否`);
    assert.equal(isAllowedHost(`https://${host}`, [host]), true, `${d}: DEV_HOSTS`);
    assert.equal(isProdHost(`https://${host}`, host), true, `${d}: PROD_HOST`);
    const dev = envFile(`KINTONE_BASE_URL=https://${host}\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=p\nKINTONE_DEV_HOSTS=${host}\n`);
    assert.equal(loadKinEnv({ file: dev }).mode, 'dev');
    const prod = envFile(`KINTONE_BASE_URL=https://${host}\nKINTONE_USERNAME=u\nKINTONE_PASSWORD=p\nKINTONE_PROD_HOST=${host}\nKINTONE_PROD_APPS=7\n`);
    assert.deepEqual([loadKinEnv({ file: prod }).mode, loadKinEnv({ file: prod }).prodApps], ['prod', ['7']]);
  }
  assert.equal(isAllowedHost('https://plugbits-us.kintone.com'), true);
  // kintone 以外のドメインは DEV_HOSTS / PROD_HOST に書いても通さない
  assert.equal(isAllowedHost('https://acme.example.com', ['acme.example.com']), false);
  assert.equal(isProdHost('https://acme.example.com', 'acme.example.com'), false);
  assert.equal(isAllowedHost('https://acme.kintone.com.evil.example', ['acme.kintone.com.evil.example']), false);
  assert.match(SETUP_HINT, /kintone\.com/);
});
