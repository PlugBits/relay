#!/usr/bin/env node
// 接続先プロファイルを読み書きする CLI。
//   node tools/kin-profile.mjs list
//   node tools/kin-profile.mjs save [--stdin-file <path>]   STDIN に JSON {id?, name, subdomain, domain, username, password?, kind, apps}
//   node tools/kin-profile.mjs use <id>
//   node tools/kin-profile.mjs status
//   node tools/kin-profile.mjs delete <id>
// 出力は常に JSON 1 個: {ok:true,...} / {ok:false,error:{code,message}}。
// 置き場: <base>/kintone/<id>.env(600・dir 700)、使用中の印 <base>/kintone/active、写し先 <base>/kintone.env。
// base は KINTONE_ROOM_CONFIG_DIR(既定 ~/.config/tiny-pulse)。
// 守り: パスワードは .env 以外のどこにも書かない(出力・エラー)。検査の GET は認証ヘッダなし。
// テスト用: RELAY_PROBE_BASE=http://127.0.0.1:<port> で検査の宛先を差し替える。
import {
  readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, renameSync, unlinkSync,
  readdirSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadKinEnv } from './kin-env.mjs';

const ID_RE = /^[a-z0-9-]{1,32}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const DOMAINS = ['cybozu.com', 'kintone.com', 'cybozu.cn'];

export class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const bad = (m) => new ProfileError('invalid', m);

export const base = () => process.env.KINTONE_ROOM_CONFIG_DIR || join(homedir(), '.config', 'tiny-pulse');
const pdir = () => join(base(), 'kintone');
const activeEnvPath = () => join(base(), 'kintone.env');
const activeMark = () => join(pdir(), 'active');

function ppath(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw bad('プロファイル ID が不正です(英小文字・数字・ハイフン、32字まで)');
  }
  return join(pdir(), id + '.env');
}

function ensureDir(d) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
}

function atomicWrite(path, text) {
  const d = dirname(path);
  ensureDir(d);
  const tmp = join(d, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 無ければよい */ }
    throw e;
  }
}

// api.py の _parse と同じ: 先頭の「# name:」と KEY=VALUE
export function parseProfile(text) {
  let name = '';
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('# name:')) { name = line.slice(7).trim(); continue; }
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim().replace(/^export\s+/, '');
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    env[k] = v;
  }
  return { name, env };
}

const readProfile = (path) => parseProfile(readFileSync(path, 'utf8'));

// 前後の空白や両端の引用符で壊れる値だけ引用符で包む
function quote(v) {
  if (v === v.trim() && !(v[0] === '"' || v[0] === "'")) return v;
  for (const q of ["'", '"']) if (!v.includes(q)) return q + v + q;
  throw bad('パスワードの前後の空白や引用符が扱えない形です');
}

export function normalizeHost(s, domain = 'cybozu.com') {
  if (!DOMAINS.includes(domain)) domain = 'cybozu.com';
  s = String(s ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.split(/[/?#]/, 1)[0].split('@').pop().split(':')[0];
  if (!s) throw bad('サブドメインを入れてください');
  if (!s.includes('.')) s += '.' + domain;
  if (!HOST_RE.test(s)) throw bad('サブドメインの形が正しくありません');
  if (!DOMAINS.some((x) => s.endsWith('.' + x))) throw bad('ドメインは cybozu.com / kintone.com / cybozu.cn だけです');
  return s;
}

function normApps(s) {
  const items = String(s ?? '').split(/[,\s、，]+/).filter(Boolean);
  if (!items.every((x) => /^\d+$/.test(x))) throw bad('アプリ番号は数字をカンマ区切りで入れてください');
  return items.map((x) => String(parseInt(x, 10))).join(',');
}

function build(name, host, user, pw, kind, apps) {
  for (const v of [name, user, pw]) if (/[\r\n]/.test(v)) throw bad('改行は使えません');
  const lines = [`# name: ${name}`, `KINTONE_BASE_URL=https://${host}`, `KINTONE_USERNAME=${quote(user)}`,
    `KINTONE_PASSWORD=${quote(pw)}`];
  if (kind === 'prod') lines.push(`KINTONE_PROD_HOST=${host}`, `KINTONE_PROD_APPS=${apps}`);
  else lines.push(`KINTONE_DEV_HOSTS=${host}`);
  return lines.join('\n') + '\n';
}

const withoutName = (text) => text.split(/\r?\n/).filter((l, i, arr) => !l.startsWith('# name:') && !(i === arr.length - 1 && l === '')).map((l) => l + '\n').join('');
const hostOf = (env) => (env.KINTONE_BASE_URL || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

function view(id, name, env) {
  const host = hostOf(env);
  return {
    id, name: name || id, host, subdomain: host.split('.')[0],
    domain: host.includes('.') ? host.split('.').slice(1).join('.') : 'cybozu.com',
    username: env.KINTONE_USERNAME || '', kind: env.KINTONE_PROD_HOST ? 'prod' : 'dev',
    apps: env.KINTONE_PROD_APPS || '', passwordSet: Boolean(env.KINTONE_PASSWORD),
  };
}

function activeId() {
  try {
    const v = readFileSync(activeMark(), 'utf8').trim();
    return ID_RE.test(v) ? v : '';
  } catch { return ''; }
}
const setActive = (id) => atomicWrite(activeMark(), id + '\n');

function profiles() {
  const d = pdir();
  const out = [];
  if (!existsSync(d)) return out;
  for (const fn of readdirSync(d).sort()) {
    if (fn.endsWith('.env') && ID_RE.test(fn.slice(0, -4))) {
      try { out.push({ id: fn.slice(0, -4), ...readProfile(join(d, fn)) }); } catch { /* 読めないものは飛ばす */ }
    }
  }
  return out;
}

const sameEnv = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

// 既存の kintone.env がどのプロファイルとも一致しなければ「dev」として取り込む
export function migrate() {
  const p = activeEnvPath();
  if (!existsSync(p) || !statSync(p).isFile()) return null;
  const text = readFileSync(p, 'utf8');
  const { env } = parseProfile(text);
  for (const pr of profiles()) {
    if (sameEnv(pr.env, env)) {
      if (!activeId()) setActive(pr.id);
      return pr.id;
    }
  }
  let id = 'dev';
  if (existsSync(ppath(id))) id = 'dev-imported';
  const body = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('# name:')).join('\n').replace(/\n*$/, '\n');
  atomicWrite(ppath(id), '# name: 開発環境\n' + body);
  setActive(id);
  return id;
}

// ---------- 検査 ----------
const scrub = (s, pw) => (pw ? String(s).split(pw).join('***') : String(s));

export function checkStatus(path, pw = '') {
  try {
    const e = loadKinEnv({ file: path });
    return { ok: true, mode: e.mode, host: new URL(e.baseUrl).hostname, prodApps: e.prodApps, error: '' };
  } catch (err) {
    return { ok: false, mode: null, host: null, prodApps: null, error: scrub(err.message || err.code || 'error', pw).slice(0, 300) };
  }
}

// 認証なしの GET /k/v1/apps.json。資格情報は送らない
export async function probeHost(host, { fetchImpl = globalThis.fetch, baseUrl = process.env.RELAY_PROBE_BASE } = {}) {
  let code;
  try {
    const url = `${baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://' + host}/k/v1/apps.json`;
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000) });
    code = res.status;
  } catch {
    return { code: null, message: 'つながりませんでした(ホスト名かネットワークを確認)' };
  }
  const message = code === 401 ? '環境は生きています' : code === 404 ? 'サブドメインの打ち間違いかも' : `ステータス ${code}`;
  return { code, message };
}

async function checkProfile(id, opts) {
  const path = ppath(id);
  const { env } = readProfile(path);
  const host = hostOf(env);
  return { status: checkStatus(path, env.KINTONE_PASSWORD || ''), probe: host ? await probeHost(host, opts) : null };
}

// ---------- コマンド ----------
export function cmdList() {
  try { migrate(); } catch { /* 読むだけの画面で失敗させない */ }
  const act = activeId();
  return { ok: true, active: act, items: profiles().map((p) => ({ ...view(p.id, p.name, p.env), active: p.id === act })) };
}

export async function cmdSave(b, opts = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('保存する内容が読めません');
  const name = String(b.name ?? '').trim().slice(0, 40);
  if (!name) throw bad('名前を入れてください');
  const kind = b.kind === 'prod' ? 'prod' : 'dev';
  const host = normalizeHost(b.subdomain, String(b.domain || 'cybozu.com'));
  const user = String(b.username ?? '').trim();
  if (!user) throw bad('ログイン名を入れてください');
  const apps = kind === 'prod' ? normApps(b.apps) : '';
  let id = String(b.id ?? '').trim();
  let oldPw = '';
  let path;
  if (id) {
    path = ppath(id);
    if (existsSync(path)) oldPw = readProfile(path).env.KINTONE_PASSWORD || '';
  } else {
    const baseId = host.split('.')[0].replace(/[^a-z0-9-]+/g, '-').slice(0, 24).replace(/^-+|-+$/g, '') || 'env';
    id = baseId;
    for (let n = 2; existsSync(ppath(id)); n++) id = `${baseId}-${n}`;
    path = ppath(id);
  }
  const pw = String(b.password ?? '') || oldPw;
  if (!pw) throw bad('パスワードを入れてください');
  if (kind === 'prod' && !apps) throw bad('本番は反映してよいアプリ番号を入れてください');
  const text = build(name, host, user, pw, kind, apps);
  migrate();
  atomicWrite(path, text);
  const isActive = activeId() === id;
  if (isActive) atomicWrite(activeEnvPath(), withoutName(text));
  const check = await checkProfile(id, opts);
  const out = { ok: true, id, synced: isActive, active: isActive, check };
  if (!isActive) out.hint = `保存だけでは接続先は変わりません。/kin use ${id} で切り替えます`;
  return out;
}

export function cmdUse(id) {
  const path = ppath(id);
  if (!existsSync(path)) throw bad('プロファイルが見つかりません');
  migrate();
  atomicWrite(activeEnvPath(), withoutName(readFileSync(path, 'utf8')));
  setActive(id);
  const s = checkStatus(path);
  return { ok: true, id, mode: s.mode, host: s.host || hostOf(readProfile(path).env) };
}

export function cmdStatus() {
  const p = activeEnvPath();
  if (!existsSync(p)) {
    throw new ProfileError('missing', '接続先が未設定です。「/kin setup」で設定してください');
  }
  try { migrate(); } catch { /* 無視 */ }
  const s = checkStatus(p);
  if (!s.ok) {
    return { ok: false, error: { code: 'invalid', message: s.error || '接続先を読めませんでした。「/kin setup」で設定し直してください' } };
  }
  const id = activeId();
  let name = '';
  if (id) { try { name = readProfile(ppath(id)).name; } catch { /* 無視 */ } }
  return { ok: true, active: id, name: name || id, host: s.host, mode: s.mode, prodApps: s.prodApps, profiles: profiles().length };
}

export function cmdDelete(id) {
  const path = ppath(id);
  if (!existsSync(path)) throw bad('プロファイルが見つかりません');
  if (activeId() === id) throw bad('使用中のプロファイルは削除できません。先に別のものへ切り替えてください');
  unlinkSync(path);
  return { ok: true, id };
}

function fail(e) {
  if (e instanceof ProfileError) return { ok: false, error: { code: e.code, message: e.message } };
  return { ok: false, error: { code: 'failed', message: '処理に失敗しました' } };
}

export async function run(argv, readStdin = () => readFileSync(0, 'utf8')) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'list': return cmdList();
      case 'status': {
        const r = cmdStatus();
        return r;
      }
      case 'use': return cmdUse(rest[0]);
      case 'delete': return cmdDelete(rest[0]);
      case 'save': {
        const i = rest.indexOf('--stdin-file');
        let text;
        if (i >= 0) {
          const f = rest[i + 1];
          if (!f) throw bad('--stdin-file にパスを指定してください');
          try { text = readFileSync(f, 'utf8'); } catch { throw bad('入力ファイルを読めませんでした'); }
          finally { try { unlinkSync(f); } catch { /* 無視 */ } }
        } else {
          text = readStdin();
        }
        let body;
        try { body = JSON.parse(text); } catch { throw bad('保存する内容が JSON として読めません'); }
        return await cmdSave(body);
      }
      default:
        throw bad('使い方: kin-profile.mjs list | save | use <id> | status | delete <id>');
    }
  } catch (e) {
    return fail(e);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exitCode = out.ok ? 0 : 1;
}
