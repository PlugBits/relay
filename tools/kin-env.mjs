// 開発環境の接続情報を読む。kin-loop.mjs と kin-probe.mjs で共通。
// 置き場は ~/.config/tiny-pulse/kintone.env(600)。KIN_ENV_FILE で差し替えられる(テスト用)。
//   KINTONE_BASE_URL=https://<sub>.cybozu.com  (米国版は https://<sub>.kintone.com)
//   KINTONE_USERNAME=<システム管理者>
//   KINTONE_PASSWORD=<パスワード>
//   KINTONE_DEV_HOSTS=<sub>.cybozu.com,...   (任意。許可する開発環境のホストを足す。.kintone.com も可)
//   KINTONE_PROD_HOST=<sub>.cybozu.com        (任意。本番扱いにするホスト。開発判定より優先。.kintone.com も可)
//   KINTONE_PROD_APPS=42,97                   (任意。本番で反映してよいアプリ番号。空なら本番への反映は全部拒否)
// 守り: 許可リスト方式。ホスト名に plugbits を含むか KINTONE_DEV_HOSTS にあるものだけ通す。
// それ以外の cybozu.com / kintone.com などは本番とみなして拒否する。ホストの末尾は .cybozu.com / .kintone.com(/ .cybozu.cn)だけ通す。値(特にパスワード)はログ・例外に出さない。
// KINTONE_PROD_HOST と同じホストは mode='prod'(開発判定より優先)。本番は読む(apps/form/probe)だけ自由、
// 反映(deploy/undo)は KINTONE_PROD_APPS にあるアプリだけ。それ以外は denied。
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ENV_FILE = join(homedir(), '.config', 'tiny-pulse', 'kintone.env');

export const SETUP_HINT = [
  '開発環境の接続情報がありません。/kin setup で画面から入れられます',
  'お試し用のアプリを1つ作ってから。既存のアプリには入れないでください',
  `手で作る場合は ${DEFAULT_ENV_FILE} に書いて chmod 600:`,
  '  KINTONE_BASE_URL=https://<サブドメイン>.cybozu.com   (米国版は .kintone.com)',
  '  KINTONE_USERNAME=<システム管理者のログイン名>',
  '  KINTONE_PASSWORD=<パスワード>',
  '  # 任意: KINTONE_DEV_HOSTS / KINTONE_PROD_HOST / KINTONE_PROD_APPS(お試しアプリに入れる場合)',
].join('\n');

export class KinEnvError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().replace(/^export\s+/, '');
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

// kintone のホストか(日本版 cybozu.com・米国版 kintone.com・中国版 cybozu.cn)
export function isKintoneHost(host) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.(cybozu\.com|kintone\.com|cybozu\.cn)$/.test(String(host || '').toLowerCase());
}

// 許可するか。local=true はテストのモック(127.0.0.1 / localhost の http)だけ通す
export function isAllowedHost(baseUrl, devHosts = [], { local = false } = {}) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (local && (host === '127.0.0.1' || host === 'localhost')) return true;
  if (u.protocol !== 'https:') return false;
  if (!isKintoneHost(host)) return false;
  if (devHosts.map((h) => h.trim().toLowerCase()).filter(Boolean).includes(host)) return true;
  return /^[a-z0-9-]*plugbits[a-z0-9-]*\.(cybozu\.com|kintone\.com|cybozu\.cn)$/.test(host);
}

// KINTONE_PROD_HOST と同じホストか(https のみ。テストのモックは local で通す)
export function isProdHost(baseUrl, prodHost, { local = false } = {}) {
  const want = String(prodHost || '').trim().toLowerCase();
  if (!want) return false;
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (host !== want) return false;
  if (u.protocol === 'https:') return isKintoneHost(host);
  return local && (host === '127.0.0.1' || host === 'localhost');
}

// 本番で反映してよいアプリか。dev は常に通す。通らなければ KinEnvError('denied')(パスワードは出さない)
export function assertAppAllowed(env, appId) {
  if (!env || env.mode !== 'prod') return;
  const id = String(appId);
  if (/^\d+$/.test(id) && (env.prodApps || []).includes(id)) return;
  const list = (env.prodApps || []).length ? (env.prodApps || []).join(',') : '(空)';
  throw new KinEnvError('denied',
    `アプリ ${id} は本番への反映を許可していません(KINTONE_PROD_APPS=${list})。` +
    'お試し用のアプリの番号を KINTONE_PROD_APPS に入れてください');
}

// { baseUrl, username, password, mode: 'dev'|'prod', prodApps } を返す。
// 無ければ KinEnvError('missing')、dev でも prod でもないホストなら KinEnvError('denied')
export function loadKinEnv({ file = process.env.KIN_ENV_FILE || DEFAULT_ENV_FILE } = {}) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new KinEnvError('missing', SETUP_HINT);
  }
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      throw new KinEnvError('perm', `${file} は他のユーザーから読めます。chmod 600 してください`);
    }
  } catch (e) {
    if (e instanceof KinEnvError) throw e;
  }
  const env = parseEnv(text);
  const baseUrl = (env.KINTONE_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl || !env.KINTONE_USERNAME || !env.KINTONE_PASSWORD) {
    throw new KinEnvError('missing', SETUP_HINT);
  }
  const devHosts = (env.KINTONE_DEV_HOSTS || '').split(',');
  const local = process.env.KIN_ALLOW_LOCAL === '1';
  const prodApps = (env.KINTONE_PROD_APPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let mode;
  if (isProdHost(baseUrl, env.KINTONE_PROD_HOST, { local })) {
    mode = 'prod'; // 開発判定(plugbits を含む / DEV_HOSTS)より優先
  } else if (isAllowedHost(baseUrl, devHosts, { local })) {
    mode = 'dev';
  } else {
    throw new KinEnvError('denied',
      `${new URL(baseUrl).hostname} は開発環境の許可リストにありません(本番の可能性があるので止めました)。` +
      '開発環境なら KINTONE_DEV_HOSTS に、お試しアプリに入れるなら KINTONE_PROD_HOST と KINTONE_PROD_APPS に足してください');
  }
  return { baseUrl, username: env.KINTONE_USERNAME, password: env.KINTONE_PASSWORD, mode, prodApps };
}

// パスワード認証のヘッダー(X-Cybozu-Authorization)
export function authHeaders({ username, password }) {
  return { 'X-Cybozu-Authorization': Buffer.from(`${username}:${password}`).toString('base64') };
}
