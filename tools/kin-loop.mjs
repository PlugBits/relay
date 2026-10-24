#!/usr/bin/env node
// kintone プラグインの pack→アップロード→読み込み→アプリに追加→反映 を REST で回す CLI。
// 使い方:
//   node tools/kin-loop.mjs apps
//   node tools/kin-loop.mjs form <appId>
//   node tools/kin-loop.mjs deploy <plugin-dir> <appId>[,<appId>...] [--ppk <path>] [--config <json-file>]
//                                  複数アプリ(開発だけ): pack/upload/install は1回、deploy.json も1回。--config の最上位 build は送らない
//   node tools/kin-loop.mjs form-change <appId> --ops <ops.json> [--plan]
//                                  フォームの変更(開発だけ)。ops は [{add:{code,type,label,...}} | {label:{code,label}} | {lookup:{code,relatedApp,relatedKeyField,fieldMappings}} | {layoutRow:{fields:[code..]}}]
//                                  --plan は書かずに突き合わせだけ。実行は控え(form-<時刻>.json)→ preview → deploy。欄の削除・ルックアップの解除はしない
//   node tools/kin-loop.mjs undo <appId>      直前の deploy の控え(relay-backup)から戻す
//   node tools/kin-loop.mjs mode [<appId>]    dev/prod と、そのアプリに反映してよいか(通信なし)
//   node tools/kin-loop.mjs status            接続先・PROD_APPS・relay の版・控えの数(通信なし)
//   node tools/kin-loop.mjs plugins <appId>   付いているプラグインと JS/CSS(読むだけ)
//   node tools/kin-loop.mjs records <appId> [--query q] [--limit n(<=20)] [--fields a,b]   読むだけ
//   node tools/kin-loop.mjs backups <appId>   控えの一覧(新しい順)
//   node tools/kin-loop.mjs customize <appId> [--js f,f] [--css f] [--mobile-js f] [--mobile-css f] [--keep-urls]
//   node tools/kin-loop.mjs pack <plugin-dir>  配布用 zip を <plugin-dir>/dist/<name>-<version>.zip に書く(通信なし・接続設定も読まない)
// 反映(deploy/undo)の前に必ず控えを ~/.config/tiny-pulse/relay-backup/<host>/<app>/<時刻>.json に書く(KIN_BACKUP_DIR で差し替え)。
// 本番(KINTONE_PROD_HOST)は KINTONE_PROD_APPS にあるアプリだけ。
// 接続情報は kin-env.mjs の loadKinEnv() が読む(~/.config/tiny-pulse/kintone.env)。
// 守り: パスワードや X-Cybozu-Authorization の値は stdout/stderr に絶対に出さない。
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync, existsSync, renameSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packPluginFromManifest } from '@kintone/plugin-packer/from-manifest';
import { loadKinEnv, authHeaders, assertAppAllowed, KinEnvError } from './kin-env.mjs';

const DEPLOY_POLL_MS = 1000;
const DEPLOY_TIMEOUT_MS = 120000;

// ---- kintone REST の薄いラッパー ----

export class KintoneApiError extends Error {
  constructor(method, path, status, data) {
    const msg = (data && data.message) ? data.message : `HTTP ${status}`;
    super(`${method} ${path} -> ${status} ${msg}`);
    this.status = status;
    this.code = data && data.code;
    this.id = data && data.id;
    this.kintoneMessage = data && data.message;
  }
}

function buildQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => sp.append(`${k}[${i}]`, item));
    } else {
      sp.append(k, String(v));
    }
  }
  return sp.toString();
}

export async function kintoneFetch(env, method, path, { query, json, form } = {}) {
  let url = env.baseUrl + path;
  const qs = buildQuery(query);
  if (qs) url += `?${qs}`;
  const headers = { ...authHeaders(env) };
  let body;
  if (form) {
    body = form;
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new KintoneApiError(method, path, res.status, data);
  }
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- ステップ実行の共通部品。steps 配列に {name, ok, ms, ...} を積む ----

async function runStep(steps, name, fn) {
  const t0 = Date.now();
  const rec = { name };
  try {
    const out = (await fn()) || {};
    const { value, ok = true, ...extra } = out;
    rec.ok = ok;
    rec.ms = Date.now() - t0;
    Object.assign(rec, extra);
    steps.push(rec);
    return value;
  } catch (e) {
    rec.ok = false;
    rec.ms = Date.now() - t0;
    steps.push(rec);
    throw e;
  }
}

// ---- 控え(backup)。反映前に毎回書く。パスワード・認証ヘッダーは入れない ----

const KEEP_ZIPS = 10;

export function backupRoot() {
  return process.env.KIN_BACKUP_DIR || join(homedir(), '.config', 'tiny-pulse', 'relay-backup');
}

function hostDir(env) {
  return join(backupRoot(), new URL(env.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_'));
}

function mkdir700(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function stamp() {
  return new Date().toISOString().replace(/:/g, '-'); // 2026-10-23T12-00-00.000Z
}

function zipDir(env, pluginId) {
  return join(hostDir(env), 'zips', pluginId);
}

function listSorted(dir, test) {
  try {
    return readdirSync(dir).filter(test).sort();
  } catch {
    return [];
  }
}

// そのプラグインの一番新しい zip(無ければ null)
function latestZip(env, pluginId) {
  const dir = zipDir(env, pluginId);
  const last = listSorted(dir, (f) => f.endsWith('.zip')).pop();
  return last ? join(dir, last) : null;
}

function saveZip(env, pluginId, zip) {
  const dir = zipDir(env, pluginId);
  mkdir700(join(hostDir(env), 'zips'));
  mkdir700(dir);
  const file = join(dir, `${stamp()}.zip`);
  writeFileSync(file, zip, { mode: 0o600 });
  chmodSync(file, 0o600);
  const all = listSorted(dir, (f) => f.endsWith('.zip'));
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_ZIPS))) {
    try { unlinkSync(join(dir, f)); } catch { /* 消せなくても続ける */ }
  }
  return file;
}

async function installedVersion(env, pluginId) {
  const res = await kintoneFetch(env, 'GET', '/k/v1/plugins.json', { query: { ids: [pluginId] } });
  const hit = (res.plugins || []).find((p) => p.id === pluginId);
  return hit ? { id: hit.id, version: String(hit.version ?? '') } : null;
}

// 反映前の状態を控える。動作テスト環境(preview)のプラグイン一覧が「次の deploy で公開される状態」なので正とし、
// 公開中(live)の一覧も添える。書けなければ throw(= 反映しない)
async function writeBackup(env, appId, pluginId) {
  const [preview, live, installed] = await Promise.all([
    kintoneFetch(env, 'GET', '/k/v1/preview/app/plugins.json', { query: { app: appId } }),
    kintoneFetch(env, 'GET', '/k/v1/app/plugins.json', { query: { app: appId } }),
    installedVersion(env, pluginId),
  ]);
  const shape = (list) => (list || []).map((p) => ({ id: p.id, name: p.name, enabled: p.enabled }));
  const appPlugins = shape(preview.plugins);
  const prevZip = latestZip(env, pluginId);
  const body = {
    version: 1,
    createdAt: new Date().toISOString(),
    host: new URL(env.baseUrl).host,
    mode: env.mode || 'dev',
    appId: String(appId),
    pluginId,
    wasOnApp: appPlugins.some((p) => p.id === pluginId),
    installed,
    prevZip,
    appPlugins,
    livePlugins: shape(live.plugins),
  };
  const dir = join(hostDir(env), String(appId));
  mkdir700(hostDir(env));
  mkdir700(dir);
  const file = join(dir, `${stamp()}.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, body };
}

function latestBackup(env, appId) {
  const dir = join(hostDir(env), String(appId));
  const last = listSorted(dir, (f) => f.endsWith('.json') && !f.endsWith('.undone.json') && !f.startsWith('form-')).pop();
  if (!last) return null;
  const file = join(dir, last);
  return { file, body: JSON.parse(readFileSync(file, 'utf8')) };
}

// ---- mode ----

export function cmdMode(env, appId) {
  if (appId !== undefined) assertAppAllowed(env, appId);
  return { ok: true, mode: env.mode || 'dev', appId: appId === undefined ? undefined : String(appId), prodApps: env.prodApps || [] };
}

// ---- apps ----

export async function cmdApps(env) {
  const apps = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await kintoneFetch(env, 'GET', '/k/v1/apps.json', { query: { limit, offset } });
    const batch = res.apps || [];
    for (const a of batch) apps.push({ appId: a.appId, name: a.name, spaceId: a.spaceId === undefined || a.spaceId === null ? null : String(a.spaceId) });
    if (batch.length < limit) break;
    offset += limit;
  }
  return { ok: true, mode: env.mode || 'dev', apps };
}

// ---- form ----

const OPTION_TYPES = new Set(['RADIO_BUTTON', 'CHECK_BOX', 'DROP_DOWN', 'MULTI_SELECT']);

function toFieldShape(f) {
  const out = { code: f.code, label: f.label, type: f.type, required: Boolean(f.required) };
  if (OPTION_TYPES.has(f.type) && f.options && typeof f.options === 'object') {
    out.options = Object.values(f.options)
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map((o) => o.label);
  }
  if (f.type === 'SUBTABLE' && f.fields) {
    out.subtable = Object.values(f.fields).map(toFieldShape);
  }
  if (isTrue(f.unique)) out.unique = true;
  if (f.lookup && typeof f.lookup === 'object') out.lookup = lookupShape(f.lookup);
  if (hasValue(f.defaultValue)) out.defaultValue = f.defaultValue;
  if (f.type === 'REFERENCE_TABLE' && f.referenceTable && typeof f.referenceTable === 'object') {
    const r = f.referenceTable;
    out.referenceTable = {
      relatedApp: relatedAppShape(r.relatedApp),
      condition: r.condition ? { field: r.condition.field, relatedField: r.condition.relatedField } : undefined,
      displayFields: r.displayFields || [],
    };
  }
  return out;
}

// REST は boolean を true / 'true' のどちらでも返しうる
const isTrue = (v) => v === true || v === 'true';
const hasValue = (v) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));

// relatedApp は code が優先(app と両方あれば code が効く)。空文字は落とす
function relatedAppShape(r) {
  const out = {};
  if (r && r.app !== undefined && r.app !== null && r.app !== '') out.app = String(r.app);
  if (r && r.code) out.code = r.code;
  return out;
}

function lookupShape(l) {
  const out = {
    relatedApp: relatedAppShape(l.relatedApp),
    relatedKeyField: l.relatedKeyField,
    fieldMappings: (l.fieldMappings || []).map((m) => ({ field: m.field, relatedField: m.relatedField })),
  };
  if (hasValue(l.lookupPickerFields)) out.lookupPickerFields = l.lookupPickerFields;
  if (hasValue(l.filterCond)) out.filterCond = l.filterCond;
  if (hasValue(l.sort)) out.sort = l.sort;
  return out;
}

function simplifyResources(list) {
  return (list || []).map((item) => (item.type === 'FILE' ? (item.file && item.file.name) : item.url));
}

export async function cmdForm(env, appId) {
  const [fieldsRes, pluginsRes, customizeRes] = await Promise.all([
    kintoneFetch(env, 'GET', '/k/v1/app/form/fields.json', { query: { app: appId } }),
    kintoneFetch(env, 'GET', '/k/v1/app/plugins.json', { query: { app: appId } }),
    kintoneFetch(env, 'GET', '/k/v1/app/customize.json', { query: { app: appId } }),
  ]);
  // 一覧(名前と ID)。設定画面・relay.config.json で一覧を選ぶ時に使う。取れなくてもフォームは返す
  const viewsRes = await kintoneFetch(env, 'GET', '/k/v1/app/views.json', { query: { app: appId } }).catch(() => null);
  // フォームの地図用(レイアウトとアプリ名)。読むだけ・取れなくてもフォームは返す
  const [layoutRes, appRes] = await Promise.all([
    kintoneFetch(env, 'GET', '/k/v1/app/form/layout.json', { query: { app: appId } }).catch(() => null),
    kintoneFetch(env, 'GET', '/k/v1/app.json', { query: { id: appId } }).catch(() => null),
  ]);
  const views = Object.values((viewsRes && viewsRes.views) || {})
    .map((v) => ({ id: String(v.id), name: v.name, type: v.type, index: Number(v.index) }))
    .sort((a, b) => a.index - b.index)
    .map(({ index, ...v }) => v);
  const fields = Object.values(fieldsRes.properties || {}).map(toFieldShape);
  const plugins = (pluginsRes.plugins || []).map((p) => ({ id: p.id, name: p.name }));
  const customize = {
    desktop: {
      js: simplifyResources(customizeRes.desktop && customizeRes.desktop.js),
      css: simplifyResources(customizeRes.desktop && customizeRes.desktop.css),
    },
    mobile: {
      js: simplifyResources(customizeRes.mobile && customizeRes.mobile.js),
      css: simplifyResources(customizeRes.mobile && customizeRes.mobile.css),
    },
  };
  const out = { ok: true, mode: env.mode || 'dev', fields, views, plugins, customize };
  if (layoutRes && Array.isArray(layoutRes.layout)) out.layout = layoutRes.layout;
  if (appRes && typeof appRes.name === 'string') out.appName = appRes.name;
  return out;
}

// ---- deploy ----

// アプリ設定を本番に反映して SUCCESS まで待つ。SUCCESS 以外・タイムアウトは throw
// appId は 1 つでも配列(複数アプリを 1 回の deploy.json で)でもよい。全部 SUCCESS なら 'SUCCESS'
async function deployAndWait(env, appId) {
  const ids = (Array.isArray(appId) ? appId : [appId]).map(String);
  await kintoneFetch(env, 'POST', '/k/v1/preview/app/deploy.json', { json: { apps: ids.map((app) => ({ app })) } });
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let statuses;
  for (;;) {
    const res = await kintoneFetch(env, 'GET', '/k/v1/preview/app/deploy.json', { query: { apps: ids } });
    statuses = ids.map((id) => {
      const hit = (res.apps || []).find((a) => String(a.app) === id);
      return hit && hit.status;
    });
    if (statuses.every((st) => st === 'SUCCESS' || st === 'FAIL' || st === 'CANCEL')) break;
    if (Date.now() >= deadline) {
      throw new Error(`deploy status timeout (${DEPLOY_TIMEOUT_MS / 1000}s)`);
    }
    await sleep(DEPLOY_POLL_MS);
  }
  const bad = statuses.findIndex((st) => st !== 'SUCCESS');
  if (bad >= 0) {
    const e = new Error(ids.length === 1 ? `deploy status: ${statuses[bad]}` : `deploy status: ${ids.map((id, i) => `${id}=${statuses[i]}`).join(', ')}`);
    e.deployStatus = statuses[bad];
    throw e;
  }
  return 'SUCCESS';
}

function loadOrGenerateKey(pluginDir, ppkPath) {
  if (ppkPath) {
    return { privateKey: readFileSync(resolve(ppkPath), 'utf8'), reused: true };
  }
  const keysDir = join(pluginDir, '.keys');
  let existing = [];
  try {
    existing = readdirSync(keysDir).filter((f) => f.endsWith('.ppk')).sort();
  } catch {
    existing = [];
  }
  if (existing.length > 0) {
    return { privateKey: readFileSync(join(keysDir, existing[0]), 'utf8'), reused: true };
  }
  return { privateKey: undefined, reused: false };
}

// appId は "42" でも "42,43"(複数アプリ)でもよい。複数なら pack・upload・install は 1 回、
// app-plugins・config は各アプリ、deploy.json は全アプリを 1 回で。控えは各アプリ
export async function cmdDeploy(env, pluginDirArg, appIdArg, { ppk, configFile } = {}) {
  const t0 = Date.now();
  const steps = [];
  let pluginId;
  let error;
  const pluginDir = resolve(pluginDirArg);
  const appIds = [...new Set(String(appIdArg).split(',').map((x) => x.trim()).filter(Boolean))];
  const multi = appIds.length > 1;
  const appId = appIds[0];
  if (multi && env.mode === 'prod') {
    // 本番は 1 アプリずつ(何も触らない)
    return { ok: false, appId, error: { code: 'prod_denied', message: '本番では複数アプリへの一括反映はできません(開発環境だけ。本番は1アプリずつ)' } };
  }
  for (const id of appIds) assertAppAllowed(env, id); // 本番で許可リスト外なら、何も触らず denied(KinEnvError)
  const ctxs = appIds.map((id) => ({ appId: id, ok: true, error: undefined, wasOnApp: false }));
  const tagOf = (c) => (multi ? { app: c.appId } : {});
  const failedError = (e) => {
    const failedStep = steps[steps.length - 1];
    return { step: failedStep ? failedStep.name : 'unknown', status: e.status, code: e.code, message: e.message };
  };

  try {
    // 1. pack
    const packed = await runStep(steps, 'pack', async () => {
      const manifestPath = join(pluginDir, 'manifest.json');
      const { privateKey, reused } = loadOrGenerateKey(pluginDir, ppk);
      const result = await packPluginFromManifest(manifestPath, privateKey);
      let note;
      if (!reused) {
        const keysDir = join(pluginDir, '.keys');
        mkdirSync(keysDir, { recursive: true });
        const keyFile = join(keysDir, `${basename(pluginDir)}.ppk`);
        writeFileSync(keyFile, result.privateKey, { mode: 0o600 });
        note = `秘密鍵が無かったので新規作成: ${keyFile}`;
      }
      return {
        value: { zip: result.plugin, pluginId: result.id },
        detail: { pluginId: result.id },
        ...(note ? { note } : {}),
      };
    });
    pluginId = packed.pluginId;

    // 1.5 backup: 何かを変える前に、各アプリの今のプラグイン一覧と入っている版を控える
    for (const c of ctxs) {
      await runStep(steps, 'backup', async () => {
        const b = await writeBackup(env, c.appId, pluginId);
        return { value: true, ...tagOf(c), detail: { file: b.file, wasOnApp: b.body.wasOnApp, prevZip: Boolean(b.body.prevZip) } };
      });
    }

    // 2. upload
    const fileKey = await runStep(steps, 'upload', async () => {
      const form = new FormData();
      form.append('file', new Blob([packed.zip]), 'plugin.zip');
      const res = await kintoneFetch(env, 'POST', '/k/v1/file.json', { form });
      return { value: res.fileKey };
    });

    // 3. install (new) or update (existing)
    await runStep(steps, 'install', async () => {
      const listRes = await kintoneFetch(env, 'GET', '/k/v1/plugins.json', { query: { ids: [pluginId] } });
      const installed = Array.isArray(listRes.plugins) && listRes.plugins.some((p) => p.id === pluginId);
      if (installed) {
        await kintoneFetch(env, 'PUT', '/k/v1/plugin.json', { json: { id: pluginId, fileKey } });
        return { value: true, detail: { action: 'update' } };
      }
      await kintoneFetch(env, 'POST', '/k/v1/plugin.json', { json: { fileKey } });
      return { value: true, detail: { action: 'install' } };
    });
    // 入れ終えた zip を控えの木に残す(次の deploy の undo が「前の版」として使う)
    try { saveZip(env, pluginId, packed.zip); } catch { /* zip を残せなくても反映は続ける */ }
  } catch (e) {
    error = failedError(e);
    for (const c of ctxs) { c.ok = false; c.error = error; }
  }

  if (!error) {
    // 4・5. 各アプリ: プラグインを付ける(preview)→ 設定(任意)。1 アプリが失敗しても他は続ける
    for (const c of ctxs) {
      try {
        await runStep(steps, 'app-plugins', async () => {
          const current = await kintoneFetch(env, 'GET', '/k/v1/preview/app/plugins.json', { query: { app: c.appId } });
          const already = Array.isArray(current.plugins) && current.plugins.some((p) => p.id === pluginId);
          if (already) {
            c.wasOnApp = true;
            return { value: true, skipped: true, ...tagOf(c) };
          }
          await kintoneFetch(env, 'POST', '/k/v1/preview/app/plugins.json', { json: { app: c.appId, ids: [pluginId] } });
          return { value: true, ...tagOf(c) };
        });
        // 設定は失敗しても止めない(API ラボ未有効など)
        if (configFile) {
          await runStep(steps, 'config', async () => {
            let config;
            try {
              config = JSON.parse(readFileSync(resolve(configFile), 'utf8'));
            } catch (e) {
              return { value: false, ok: false, skipped: true, ...tagOf(c), note: `設定ファイルを読めません: ${e.message}` };
            }
            // 最上位の build は kin-build の設定で、プラグインの設定値ではない(送らない・比較にも入れない)
            if (config && typeof config === 'object' && !Array.isArray(config)) delete config.build;
            // build だけのファイル(設定値が空)は送らない。空の設定を PUT すると画面で入れた設定が消える
            if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length === 0) {
              return { value: false, skipped: true, ...tagOf(c), note: 'relay.config.json に設定値が無いので送っていません(設定画面の値をそのまま使います)' };
            }
            const stringConfig = {};
            for (const [k, v] of Object.entries(config)) stringConfig[k] = String(v);
            // 前に送った値と同じなら送らない(設定画面で選び直した値を、反映のたびに上書きしないため)
            const sentFile = join(pluginDir, '.keys', `config-sent-${c.appId}.json`);
            const body = JSON.stringify(stringConfig);
            let sent = null;
            try { sent = readFileSync(sentFile, 'utf8'); } catch { sent = null; }
            // アプリに初めて付けた時(外されて付け直した時も)は必ず送る
            if (sent === body && c.wasOnApp) {
              return { value: false, skipped: true, unchanged: true, ...tagOf(c), note: 'relay.config.json は前回から変わっていないので送っていません(設定画面の値をそのまま使います)' };
            }
            try {
              await kintoneFetch(env, 'PUT', '/k/v1/preview/app/plugin/config.json', {
                json: { app: c.appId, id: pluginId, config: stringConfig },
              });
              try { writeFileSync(sentFile, body, { mode: 0o600 }); } catch { /* 印を残せなくても反映は続ける */ }
              return { value: true, ...tagOf(c) };
            } catch (e) {
              return { value: false, ok: false, skipped: true, ...tagOf(c), note: `設定は画面で(${e.code === 'GAIA_OF02' ? 'kintone のアップデートオプションで「プラグインの設定」API が無効' : (e.kintoneMessage || e.message)})` };
            }
          });
        }
      } catch (e) {
        c.ok = false;
        c.error = failedError(e);
        if (multi) c.error.appId = c.appId;
      }
    }

    // 6. deploy + poll(失敗しなかったアプリを 1 回で)
    const targets = ctxs.filter((c) => c.ok);
    if (targets.length) {
      try {
        await runStep(steps, 'deploy', async () => {
          const status = await deployAndWait(env, targets.map((c) => c.appId));
          return { value: status, ...(multi ? { apps: targets.map((c) => c.appId) } : {}), detail: { status } };
        });
      } catch (e) {
        const err = failedError(e);
        for (const c of targets) { c.ok = false; c.error = err; }
      }
    }
    const firstBad = ctxs.find((c) => !c.ok);
    if (firstBad) error = firstBad.error;
  }

  const ok = ctxs.every((c) => c.ok);
  const seconds = Math.round((Date.now() - t0)) / 1000;
  // origin は画面の URL(一覧・設定)を案内するため。ホストだけで認証情報は含まない
  const output = { ok, pluginId, appId, mode: env.mode || 'dev', origin: new URL(env.baseUrl).origin, seconds, steps };
  if (multi) {
    output.apps = ctxs.map((c) => ({
      appId: c.appId,
      ok: c.ok,
      steps: steps.filter((x) => x.app === c.appId || x.name === 'deploy'), // deploy は全アプリ共通の 1 回
      ...(c.error ? { error: c.error } : {}),
    }));
  }
  if (error) output.error = error;
  return output;
}

// ---- form-change(フォームの変更。dev だけ) ----

const FORM_CHANGE_MAX_OPS = 50;
// add で作れる型。RECORD_NUMBER・CREATOR など自動の欄と、LABEL/SPACER/HR(elementId で扱う欄)は対象外
const ADD_TYPES = new Set([
  'SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT', 'RICH_TEXT', 'NUMBER', 'CALC', 'CHECK_BOX', 'RADIO_BUTTON',
  'MULTI_SELECT', 'DROP_DOWN', 'DATE', 'TIME', 'DATETIME', 'LINK', 'USER_SELECT', 'ORGANIZATION_SELECT',
  'GROUP_SELECT', 'FILE', 'GROUP', 'SUBTABLE', 'REFERENCE_TABLE',
]);
const LOOKUP_TYPES = new Set(['SINGLE_LINE_TEXT', 'NUMBER']);
const NOT_IN_ROW_TYPES = new Set(['GROUP', 'SUBTABLE']); // layoutRow の 1 行に入れられない欄
const NOT_SUPPORTED_MESSAGE = '欄の削除とルックアップの解除はしません(人が画面で)';

class OpsError extends Error {
  constructor(code, message, index) {
    super(message);
    this.opsCode = code;
    this.index = index;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function readOpsFile(file) {
  let ops;
  try {
    ops = JSON.parse(readFileSync(resolve(file), 'utf8'));
  } catch (e) {
    throw new OpsError('bad_ops', `ops ファイルを読めません: ${e.code || e.message}`);
  }
  if (!Array.isArray(ops) || ops.length === 0) throw new OpsError('bad_ops', 'ops は 1 件以上の配列にしてください');
  if (ops.length > FORM_CHANGE_MAX_OPS) throw new OpsError('bad_ops', `ops は最大 ${FORM_CHANGE_MAX_OPS} 件です`);
  // 削除・解除は中身を見る前に断る
  ops.forEach((op, i) => {
    if (!isPlainObject(op)) return;
    const keys = Object.keys(op);
    if (keys.some((k) => /^(delete|remove|drop)/i.test(k)) || (keys.includes('lookup') && op.lookup === null)
      || (isPlainObject(op.lookup) && (op.lookup.relatedApp === null || op.lookup.remove === true))) {
      throw new OpsError('not_supported', NOT_SUPPORTED_MESSAGE, i);
    }
  });
  return ops;
}

// 動作テスト環境(preview)の今のフォーム。反映前の変更も入っている状態が「次の deploy で出る状態」
async function loadFormState(env, appId) {
  const [fieldsRes, layoutRes] = await Promise.all([
    kintoneFetch(env, 'GET', '/k/v1/preview/app/form/fields.json', { query: { app: appId } }),
    kintoneFetch(env, 'GET', '/k/v1/preview/app/form/layout.json', { query: { app: appId } }),
  ]);
  return { fieldsRes, layoutRes };
}

// 欄コード → {type, label, parent?}。サブテーブルの中の欄は parent にテーブルのコードを持つ
function indexFields(properties) {
  const map = new Map();
  for (const f of Object.values(properties || {})) {
    map.set(f.code, { type: f.type, label: f.label, lookup: Boolean(f.lookup) });
    if (f.type === 'SUBTABLE' && f.fields) {
      for (const g of Object.values(f.fields)) map.set(g.code, { type: g.type, label: g.label, lookup: Boolean(g.lookup), parent: f.code });
    }
  }
  return map;
}

function normalizeRelatedApp(v, index) {
  if (typeof v === 'number' || nonEmptyString(v)) return { app: String(v) };
  if (isPlainObject(v) && (v.app !== undefined || v.code)) {
    const out = {};
    if (v.app !== undefined && v.app !== null && v.app !== '') out.app = String(v.app);
    if (nonEmptyString(v.code)) out.code = v.code;
    if (Object.keys(out).length) return out;
  }
  throw new OpsError('bad_ops', 'lookup.relatedApp は アプリ番号か {app, code} で指定してください', index);
}

// 参照先アプリのフォーム(公開中のもの)。読めなければ null(警告にして続ける)
async function loadRelatedProps(env, cache, app) {
  if (!cache.has(app)) {
    try {
      const res = await kintoneFetch(env, 'GET', '/k/v1/app/form/fields.json', { query: { app } });
      cache.set(app, res.properties || {});
    } catch {
      cache.set(app, null);
    }
  }
  return cache.get(app);
}

// ops を今のフォームと突き合わせ、実行手順に直す。書かない。不備は OpsError(bad_ops)
async function buildFormPlan(env, appId, ops, fields) {
  const work = indexFields(fields);
  const relatedCache = new Map();
  const plan = [];
  const actions = [];
  const warnings = [];
  const newCodes = new Set();
  const nest = (code, patch) => {
    const cur = work.get(code);
    if (cur && cur.parent) {
      return { [cur.parent]: { type: 'SUBTABLE', fields: { [code]: { type: cur.type, code, ...patch } } } };
    }
    return { [code]: { type: cur.type, code, ...patch } };
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const keys = isPlainObject(op) ? Object.keys(op) : [];
    if (keys.length !== 1 || !['add', 'label', 'lookup', 'layoutRow'].includes(keys[0]) || !isPlainObject(op[keys[0]])) {
      throw new OpsError('bad_ops', 'op は {add}・{label}・{lookup}・{layoutRow} のどれか 1 つだけを持つオブジェクトにしてください', i);
    }
    const kind = keys[0];
    const body = op[kind];
    if (kind === 'add') {
      const { code, type, label, options, ...rest } = body;
      if (!nonEmptyString(code) || !nonEmptyString(type) || !nonEmptyString(label)) {
        throw new OpsError('bad_ops', 'add には code・type・label が必要です', i);
      }
      if (work.has(code)) throw new OpsError('bad_ops', `欄コード ${code} は既にあります(add できません)`, i);
      if (!ADD_TYPES.has(type)) throw new OpsError('bad_ops', `add できない型です: ${type}`, i);
      if ('lookup' in rest) throw new OpsError('bad_ops', 'add の中に lookup は書けません。欄を足してから {lookup} の op で付けてください', i);
      const prop = { type, code, label, ...rest };
      if (options !== undefined) {
        if (!OPTION_TYPES.has(type)) throw new OpsError('bad_ops', `${type} に options は付けられません`, i);
        if (!Array.isArray(options) || options.length === 0 || options.some((o) => !nonEmptyString(o)) || new Set(options).size !== options.length) {
          throw new OpsError('bad_ops', 'options は重複しない文字列の配列にしてください', i);
        }
        prop.options = Object.fromEntries(options.map((o, n) => [o, { label: o, index: String(n) }]));
      } else if (OPTION_TYPES.has(type)) {
        throw new OpsError('bad_ops', `${type} には options が必要です`, i);
      }
      work.set(code, { type, label });
      newCodes.add(code);
      plan.push({ i, op: 'add', code, summary: `欄「${label}」(${code}・${type})を追加` });
      actions.push({ i, op: 'add', code, method: 'POST', path: '/k/v1/preview/app/form/fields.json', json: { app: appId, properties: { [code]: prop } } });
    } else if (kind === 'label') {
      const { code, label } = body;
      if (!nonEmptyString(code) || !nonEmptyString(label)) throw new OpsError('bad_ops', 'label には code と label が必要です', i);
      const cur = work.get(code);
      if (!cur) throw new OpsError('bad_ops', `欄コード ${code} がアプリにありません(label できません)`, i);
      plan.push({ i, op: 'label', code, summary: `欄 ${code} のラベルを「${cur.label}」から「${label}」に変更` });
      actions.push({ i, op: 'label', code, method: 'PUT', path: '/k/v1/preview/app/form/fields.json', json: { app: appId, properties: nest(code, { label }) } });
      cur.label = label;
    } else if (kind === 'lookup') {
      const { code, relatedKeyField, fieldMappings, lookupPickerFields } = body;
      if (!nonEmptyString(code)) throw new OpsError('bad_ops', 'lookup には code が必要です', i);
      const cur = work.get(code);
      if (!cur) throw new OpsError('bad_ops', `欄コード ${code} がアプリにありません(lookup を付けられません)`, i);
      if (!LOOKUP_TYPES.has(cur.type)) throw new OpsError('bad_ops', `欄 ${code} は ${cur.type} なのでルックアップにできません(文字列1行か数値の欄だけ)`, i);
      const relatedApp = normalizeRelatedApp(body.relatedApp, i);
      if (!nonEmptyString(relatedKeyField)) throw new OpsError('bad_ops', 'lookup には relatedKeyField が必要です', i);
      if (!Array.isArray(fieldMappings) || fieldMappings.some((m) => !isPlainObject(m) || !nonEmptyString(m.field) || !nonEmptyString(m.relatedField))) {
        throw new OpsError('bad_ops', 'lookup.fieldMappings は [{field, relatedField}] にしてください', i);
      }
      if (lookupPickerFields !== undefined && (!Array.isArray(lookupPickerFields) || lookupPickerFields.some((x) => !nonEmptyString(x)))) {
        throw new OpsError('bad_ops', 'lookup.lookupPickerFields は欄コードの配列にしてください', i);
      }
      for (const m of fieldMappings) {
        if (m.field === code) throw new OpsError('bad_ops', `fieldMappings の field に ${code} 自身は指定できません`, i);
        if (!work.has(m.field)) throw new OpsError('bad_ops', `fieldMappings の field ${m.field} がこのアプリにありません`, i);
      }
      if (cur.lookup) warnings.push(`op ${i}: 欄 ${code} は既にルックアップです(設定を上書きします)`);
      // 参照先アプリのキー欄が一意か。一意でないと GAIA_LO03 で失敗する。code は app より優先されるので、app だけの時に確かめる
      if (relatedApp.code) {
        warnings.push(`op ${i}: relatedApp.code(${relatedApp.code})は app より優先されます。参照先のキー欄が一意かは確かめていません`);
      } else {
        const props = await loadRelatedProps(env, relatedCache, relatedApp.app);
        if (!props) {
          warnings.push(`op ${i}: 参照先アプリ ${relatedApp.app} のフォームを読めなかったので、キー欄が一意かは確かめていません`);
        } else {
          const key = props[relatedKeyField];
          if (!key) throw new OpsError('bad_ops', `参照先アプリ ${relatedApp.app} に relatedKeyField ${relatedKeyField} がありません`, i);
          if (key.type !== 'RECORD_NUMBER' && !isTrue(key.unique)) {
            throw new OpsError('bad_ops', `参照先アプリ ${relatedApp.app} の ${relatedKeyField} は「値の重複を禁止」になっていないので、ルックアップのキーにできません(GAIA_LO03)。参照先で一意にするか、レコード番号を使ってください`, i);
          }
          for (const m of fieldMappings) {
            if (!props[m.relatedField]) throw new OpsError('bad_ops', `参照先アプリ ${relatedApp.app} に ${m.relatedField} がありません(fieldMappings)`, i);
          }
          for (const f of lookupPickerFields || []) {
            if (!props[f]) throw new OpsError('bad_ops', `参照先アプリ ${relatedApp.app} に ${f} がありません(lookupPickerFields)`, i);
          }
        }
      }
      const lookup = { relatedApp, relatedKeyField, fieldMappings: fieldMappings.map((m) => ({ field: m.field, relatedField: m.relatedField })) };
      if (lookupPickerFields) lookup.lookupPickerFields = lookupPickerFields;
      const appName = relatedApp.code ? `コード ${relatedApp.code}` : relatedApp.app;
      cur.lookup = true;
      plan.push({ i, op: 'lookup', code, summary: `欄 ${code} をアプリ ${appName} の ${relatedKeyField} で引くルックアップにする(コピー ${fieldMappings.length} 件)` });
      actions.push({ i, op: 'lookup', code, method: 'PUT', path: '/k/v1/preview/app/form/fields.json', json: { app: appId, properties: nest(code, { lookup }) } });
    } else {
      const codes = body.fields;
      if (!Array.isArray(codes) || codes.length === 0 || codes.some((c) => !nonEmptyString(c)) || new Set(codes).size !== codes.length) {
        throw new OpsError('bad_ops', 'layoutRow.fields は重複しない欄コードの配列にしてください', i);
      }
      for (const c of codes) {
        const cur = work.get(c);
        if (!cur) throw new OpsError('bad_ops', `欄コード ${c} がアプリにありません(layoutRow)`, i);
        if (cur.parent) throw new OpsError('bad_ops', `欄 ${c} はテーブルの中の欄なので、行にまとめられません`, i);
        if (NOT_IN_ROW_TYPES.has(cur.type)) throw new OpsError('bad_ops', `欄 ${c} は ${cur.type} なので、行にまとめられません`, i);
      }
      const types = Object.fromEntries(codes.map((c) => [c, work.get(c).type]));
      plan.push({ i, op: 'layoutRow', code: codes.join(','), summary: `欄 ${codes.join('・')} を 1 行にして、レイアウトの末尾に置く` });
      actions.push({ i, op: 'layoutRow', code: codes.join(','), layoutRow: { fields: codes, types } });
    }
  }
  return { plan, actions, warnings };
}

// 今のレイアウトから該当の欄を抜き、新しい行を末尾に足したレイアウトを返す
function layoutWithRow(layout, codes, types) {
  const moved = new Map();
  const strip = (rows) => (rows || []).map((row) => {
    if (row.type === 'ROW') {
      const kept = [];
      for (const el of row.fields || []) {
        if (el.code && codes.includes(el.code)) moved.set(el.code, el);
        else kept.push(el);
      }
      return kept.length || !(row.fields || []).length ? { ...row, fields: kept } : null; // 空になった行は消す
    }
    if (row.type === 'GROUP') return { ...row, layout: strip(row.layout) };
    return row;
  }).filter(Boolean);
  const rows = strip(layout);
  rows.push({ type: 'ROW', fields: codes.map((c) => moved.get(c) || { type: types[c], code: c }) });
  return rows;
}

export async function cmdFormChange(env, appId, { opsFile, plan: planOnly = false } = {}) {
  const t0 = Date.now();
  const mode = env.mode || 'dev';
  if (!planOnly && mode === 'prod') {
    return { ok: false, mode, appId: String(appId), error: { code: 'prod_denied', message: '本番ではフォームを変更できません(開発環境だけ)' } };
  }
  let built;
  let state;
  try {
    const ops = readOpsFile(opsFile);
    state = await loadFormState(env, appId);
    built = await buildFormPlan(env, appId, ops, state.fieldsRes.properties || {});
  } catch (e) {
    if (e instanceof OpsError) {
      return { ok: false, mode, appId: String(appId), error: { code: e.opsCode, message: e.message, ...(e.index !== undefined ? { index: e.index } : {}) } };
    }
    throw e;
  }
  if (planOnly) {
    return { ok: true, mode, appId: String(appId), plan: built.plan, warnings: built.warnings };
  }

  // 控え: 変える前の fields と layout(preview)
  let backup;
  try {
    const dir = join(hostDir(env), String(appId));
    mkdir700(hostDir(env));
    mkdir700(dir);
    backup = join(dir, `form-${stamp()}.json`);
    const body = {
      version: 1,
      kind: 'form',
      createdAt: new Date().toISOString(),
      host: new URL(env.baseUrl).host,
      mode,
      appId: String(appId),
      revision: state.fieldsRes.revision,
      properties: state.fieldsRes.properties || {},
      layout: state.layoutRes.layout || [],
    };
    writeFileSync(backup, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    chmodSync(backup, 0o600);
  } catch (e) {
    return { ok: false, mode, appId: String(appId), applied: [], error: { step: 'backup', message: `控えを書けないので変更しません: ${e.message}` } };
  }

  const applied = [];
  for (const a of built.actions) {
    try {
      if (a.layoutRow) {
        const cur = await kintoneFetch(env, 'GET', '/k/v1/preview/app/form/layout.json', { query: { app: appId } });
        const layout = layoutWithRow(cur.layout, a.layoutRow.fields, a.layoutRow.types);
        await kintoneFetch(env, 'PUT', '/k/v1/preview/app/form/layout.json', { json: { app: appId, layout } });
      } else {
        await kintoneFetch(env, a.method, a.path, { json: a.json });
      }
      applied.push({ i: a.i, op: a.op, code: a.code, ok: true });
    } catch (e) {
      applied.push({ i: a.i, op: a.op, code: a.code, ok: false, error: e.kintoneMessage || e.message });
      return {
        ok: false,
        mode,
        appId: String(appId),
        applied,
        backup,
        seconds: Math.round(Date.now() - t0) / 1000,
        note: `op ${a.i} で止めました(残りはやっていません)。動作テスト環境にはここまでの変更が残っていますが、反映(deploy)はしていません`,
        error: { step: 'op', index: a.i, code: e.code, status: e.status, message: e.message },
      };
    }
  }
  try {
    await deployAndWait(env, appId);
  } catch (e) {
    return {
      ok: false, mode, appId: String(appId), applied, backup, seconds: Math.round(Date.now() - t0) / 1000,
      error: { step: 'deploy', code: e.code, status: e.status, message: e.message },
    };
  }
  return { ok: true, mode, appId: String(appId), applied, backup, seconds: Math.round(Date.now() - t0) / 1000 };
}

// ---- pack(配布用 zip) ----

// 反映と同じ鍵(.keys/*.ppk)で包むので、プラグイン ID は反映したものと同じ。dist/ は .gitignore 済み
export async function cmdPack(pluginDirArg) {
  const pluginDir = resolve(pluginDirArg);
  const manifestPath = join(pluginDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, error: { code: 'no_manifest', message: `${pluginDir} に manifest.json がありません` } };
  }
  const { privateKey, reused } = loadOrGenerateKey(pluginDir);
  if (!reused) {
    return { ok: false, error: { code: 'no_key', message: '.keys/*.ppk がありません。先に一度反映してください(鍵が変わるとプラグイン ID も変わるため)' } };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const result = await packPluginFromManifest(manifestPath, privateKey);
  const version = String(manifest.version ?? '0');
  const dist = join(pluginDir, 'dist');
  mkdirSync(dist, { recursive: true });
  const file = join(dist, `${basename(pluginDir)}-${version.replace(/[^0-9A-Za-z.-]/g, '_')}.zip`);
  writeFileSync(file, result.plugin);
  return { ok: true, pluginId: result.id, version, file, bytes: result.plugin.length };
}

// ---- undo ----

// 直前の控えに戻す。公式 API で戻せない物は「戻せません」と正直に返す。
// アプリからプラグインを外す公式 API は無い(preview/app/plugins.json は GET と POST=追加だけ。
// DELETE /k/v1/plugin.json は kintone 全体からのアンインストールで、他のアプリにも効くので使わない)。
export async function cmdUndo(env, appId) {
  assertAppAllowed(env, appId);
  const backup = latestBackup(env, appId);
  if (!backup) {
    return { ok: false, appId: String(appId), error: { message: `アプリ ${appId} の控えがありません(戻せません)` } };
  }
  if (backup.body.kind === 'customize') return undoCustomize(env, appId, backup);
  const b = backup.body;
  const parts = [];
  let restored = false;
  let failed = false;

  // 1. アプリに付いているか
  if (b.wasOnApp) {
    parts.push({ name: 'app-plugin', status: 'unchanged', message: 'プラグインは元からアプリに付いていました(外しません)' });
  } else {
    parts.push({
      name: 'app-plugin',
      status: 'cannot',
      message: '戻せません: 画面で外してください(アプリ設定のプラグインから。アプリのプラグインを外す公式 API が無いため)',
    });
  }

  // 2. 読み込み済みプラグインの版
  try {
    const cur = await installedVersion(env, b.pluginId);
    if (!b.installed) {
      parts.push({
        name: 'plugin-version',
        status: 'cannot',
        message: '戻せません: この deploy で初めて読み込んだプラグインです。他のアプリにも効くので自動では消しません(画面でアンインストールしてください)',
      });
    } else if (b.prevZip && existsSync(b.prevZip)) {
      // 開発中は manifest の version を上げないことが多いので、版の番号は見ずに控えの zip で戻す
      const form = new FormData();
      form.append('file', new Blob([readFileSync(b.prevZip)]), 'plugin.zip');
      const up = await kintoneFetch(env, 'POST', '/k/v1/file.json', { form });
      await kintoneFetch(env, 'PUT', '/k/v1/plugin.json', { json: { id: b.pluginId, fileKey: up.fileKey } });
      restored = true;
      parts.push({
        name: 'plugin-version',
        status: 'restored',
        message: `前の版を読み込み直しました(控えの zip・版 ${b.installed.version})`,
      });
    } else if (cur && cur.version === b.installed.version) {
      parts.push({
        name: 'plugin-version',
        status: 'cannot',
        message: `戻せません: 前の中身の zip が控えにありません(版は ${b.installed.version} のまま)。plugins/ のコードを戻して保存し直してください`,
      });
    } else {
      parts.push({
        name: 'plugin-version',
        status: 'cannot',
        message: `戻せません: 前の版(${b.installed.version})の zip が控えにありません。plugins/ のコードを戻して保存し直してください`,
      });
    }
  } catch (e) {
    failed = true;
    parts.push({ name: 'plugin-version', status: 'failed', message: e.message });
  }

  // 3. 戻した分があればアプリ設定を反映
  let deployed = false;
  if (restored) {
    try {
      await deployAndWait(env, appId);
      deployed = true;
      parts.push({ name: 'deploy', status: 'restored', message: 'アプリ設定を反映しました' });
      try { renameSync(backup.file, backup.file.replace(/\.json$/, '.undone.json')); } catch { /* 印を付けられなくても続ける */ }
    } catch (e) {
      failed = true;
      parts.push({ name: 'deploy', status: 'failed', message: e.message });
    }
  } else {
    parts.push({ name: 'deploy', status: 'unchanged', message: '戻した物が無いので反映していません' });
  }

  return {
    ok: !failed,
    appId: String(appId),
    pluginId: b.pluginId,
    mode: env.mode || 'dev',
    backup: backup.file,
    restored,
    deployed,
    cannot: parts.filter((p) => p.status === 'cannot').map((p) => p.name),
    parts,
  };
}

// ---- status / backups ----

function relayVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

// そのホストの控え(json)を新しい順に。undone も含む。zips/ は数えない
function listBackupFiles(env, appId) {
  const hd = hostDir(env);
  const appDirs = appId === undefined
    ? listSorted(hd, (f) => f !== 'zips' && /^\d+$/.test(f)).map((f) => join(hd, f))
    : [join(hd, String(appId))];
  const out = [];
  for (const d of appDirs) {
    for (const f of listSorted(d, (x) => x.endsWith('.json'))) out.push(join(d, f));
  }
  return out;
}

export function cmdStatus(env) {
  return {
    ok: true,
    mode: env.mode || 'dev',
    host: new URL(env.baseUrl).host,
    prodApps: env.prodApps || [],
    relayVersion: relayVersion(),
    backups: listBackupFiles(env).length,
  };
}

export function cmdBackups(env, appId) {
  const backups = [];
  for (const file of listBackupFiles(env, appId)) {
    let b;
    try { b = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const kind = b.kind || 'plugin';
    const pluginName = b.pluginId ? ((b.appPlugins || []).find((p) => p.id === b.pluginId) || {}).name : undefined;
    const item = {
      file: basename(file),
      createdAt: b.createdAt || null,
      pluginId: b.pluginId || null,
      ...(pluginName ? { pluginName } : {}),
      version: (b.installed && b.installed.version) || null,
      undone: file.endsWith('.undone.json'),
      kind,
    };
    backups.push(item);
  }
  backups.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
  return { ok: true, appId: String(appId), backups };
}

// ---- plugins ----

function entryShape(item) {
  return item.type === 'FILE' ? { type: 'FILE', name: item.file && item.file.name } : { type: 'URL', url: item.url };
}

export async function cmdPlugins(env, appId) {
  const [pluginsRes, customizeRes] = await Promise.all([
    kintoneFetch(env, 'GET', '/k/v1/app/plugins.json', { query: { app: appId } }),
    kintoneFetch(env, 'GET', '/k/v1/app/customize.json', { query: { app: appId } }),
  ]);
  const list = (o, k) => ((o && o[k]) || []).map(entryShape);
  return {
    ok: true,
    appId: String(appId),
    plugins: (pluginsRes.plugins || []).map((p) => ({ id: p.id, name: p.name, enabled: p.enabled })),
    customize: {
      desktop: { js: list(customizeRes.desktop, 'js'), css: list(customizeRes.desktop, 'css') },
      mobile: { js: list(customizeRes.mobile, 'js'), css: list(customizeRes.mobile, 'css') },
    },
  };
}

// ---- records ----

const RECORDS_MAX = 20;
const RECORDS_DEFAULT = 10;

function flattenValue(field) {
  if (!field || typeof field !== 'object' || !('type' in field)) return field;
  const v = field.value;
  if (field.type === 'FILE') return (Array.isArray(v) ? v : []).map((x) => x && x.name);
  if (field.type === 'SUBTABLE') {
    return (Array.isArray(v) ? v : []).map((row) => flattenRecord((row && row.value) || {}));
  }
  return v;
}

function flattenRecord(rec) {
  const out = {};
  for (const [code, field] of Object.entries(rec || {})) out[code] = flattenValue(field);
  return out;
}

export async function cmdRecords(env, appId, { query, limit, fields } = {}) {
  let n = RECORDS_DEFAULT;
  if (limit !== undefined) {
    if (!/^\d+$/.test(String(limit)) || Number(limit) < 1) {
      throw new Error('records: --limit は 1 以上の整数で指定してください');
    }
    n = Math.min(Number(limit), RECORDS_MAX);
  }
  // クエリ末尾の limit は上限以下に直し、無ければ足す(上限を超えて取らない)
  let q = String(query || '').trim();
  let offsetPart = '';
  const m = q.match(/\s*\blimit\s+(\d+)(\s+offset\s+\d+)?\s*$/i);
  if (m) {
    n = Math.min(n, Math.max(1, Number(m[1])));
    offsetPart = (m[2] || '').trim();
    q = q.slice(0, m.index).trim();
  }
  q = `${q} limit ${n} ${offsetPart}`.trim();
  const res = await kintoneFetch(env, 'GET', '/k/v1/records.json', {
    query: { app: appId, query: q, totalCount: 'true', ...(fields && fields.length ? { fields } : {}) },
  });
  const tc = res.totalCount === null || res.totalCount === undefined ? null : Number(res.totalCount);
  return {
    ok: true,
    appId: String(appId),
    totalCount: Number.isFinite(tc) ? tc : null,
    records: (res.records || []).slice(0, n).map(flattenRecord),
  };
}

// ---- customize ----

const CUSTOMIZE_KEYS = [['desktop', 'js'], ['desktop', 'css'], ['mobile', 'js'], ['mobile', 'css']];

// 控え用の形。fileKey は入れない(戻しに使えないので)
function customizeSnapshot(res) {
  const out = {};
  for (const [dev, kind] of CUSTOMIZE_KEYS) {
    out[dev] = out[dev] || {};
    out[dev][kind] = ((res[dev] && res[dev][kind]) || []).map((it) => (
      it.type === 'FILE'
        ? { type: 'FILE', name: it.file && it.file.name, ...(it.file && it.file.size ? { size: it.file.size } : {}) }
        : { type: 'URL', url: it.url }));
  }
  return out;
}

function writeCustomizeBackup(env, appId, current) {
  const body = {
    version: 1,
    kind: 'customize',
    createdAt: new Date().toISOString(),
    host: new URL(env.baseUrl).host,
    mode: env.mode || 'dev',
    appId: String(appId),
    scope: current.scope,
    customize: customizeSnapshot(current),
  };
  const dir = join(hostDir(env), String(appId));
  mkdir700(hostDir(env));
  mkdir700(dir);
  const file = join(dir, `${stamp()}.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, body };
}

export async function cmdCustomize(env, appId, { js = [], css = [], mobileJs = [], mobileCss = [], keepUrls = false } = {}) {
  const t0 = Date.now();
  const steps = [];
  assertAppAllowed(env, appId); // 本番で許可リスト外なら、何も触らず denied(KinEnvError)
  const wanted = { 'desktop.js': js, 'desktop.css': css, 'mobile.js': mobileJs, 'mobile.css': mobileCss };
  if (Object.values(wanted).every((l) => l.length === 0) && !keepUrls) {
    return { ok: false, appId: String(appId), error: { message: 'customize: --js / --css / --mobile-js / --mobile-css のどれかが必要です' } };
  }
  // 先に全ファイルを読む。読めなければ何も触らない
  const files = {};
  for (const [key, list] of Object.entries(wanted)) {
    files[key] = [];
    for (const p of list) {
      let data;
      try {
        data = readFileSync(resolve(p));
      } catch (e) {
        return { ok: false, appId: String(appId), error: { message: `ファイルを読めません: ${p} (${e.code || e.message})` } };
      }
      files[key].push({ name: basename(p), data });
    }
  }
  let ok = true;
  let error;
  try {
    // 1. backup: 今の動作テスト環境の設定を控える
    let current;
    await runStep(steps, 'backup', async () => {
      current = await kintoneFetch(env, 'GET', '/k/v1/preview/app/customize.json', { query: { app: appId } });
      const b = writeCustomizeBackup(env, appId, current);
      return { value: true, detail: { file: b.file } };
    });
    // 2. upload
    const entries = {};
    for (const [dev, kind] of CUSTOMIZE_KEYS) {
      const key = `${dev}.${kind}`;
      entries[key] = keepUrls
        ? ((current[dev] && current[dev][kind]) || []).filter((it) => it.type === 'URL').map((it) => ({ type: 'URL', url: it.url }))
        : [];
    }
    for (const [key, list] of Object.entries(files)) {
      for (const f of list) {
        await runStep(steps, `upload ${key}`, async () => {
          const form = new FormData();
          form.append('file', new Blob([f.data]), f.name);
          const res = await kintoneFetch(env, 'POST', '/k/v1/file.json', { form });
          entries[key].push({ type: 'FILE', file: { fileKey: res.fileKey } });
          return { value: true, detail: { name: f.name } };
        });
      }
    }
    // 3. PUT customize
    await runStep(steps, 'customize', async () => {
      const json = {
        app: appId,
        ...(current.scope ? { scope: current.scope } : {}),
        desktop: { js: entries['desktop.js'], css: entries['desktop.css'] },
        mobile: { js: entries['mobile.js'], css: entries['mobile.css'] },
      };
      await kintoneFetch(env, 'PUT', '/k/v1/preview/app/customize.json', { json });
      return { value: true, detail: { keepUrls } };
    });
    // 4. deploy + poll
    await runStep(steps, 'deploy', async () => {
      const status = await deployAndWait(env, appId);
      return { value: status, detail: { status } };
    });
  } catch (e) {
    ok = false;
    const failedStep = steps[steps.length - 1];
    error = { step: failedStep ? failedStep.name : 'unknown', status: e.status, code: e.code, message: e.message };
  }
  const seconds = Math.round(Date.now() - t0) / 1000;
  const output = { ok, appId: String(appId), mode: env.mode || 'dev', seconds, steps };
  if (error) output.error = error;
  return output;
}

// customize の控えから戻す。URL の項目だけ戻せる。FILE は fileKey を控えていない(下の注)ので戻せません。
// 公式 API(PUT preview/app/customize.json)の file.fileKey は「既存のファイルを残す場合に、動作テスト環境の設定を取得して
// 得たキーを指定する」とだけ書かれていて、別の設定に差し替えた後の古いキーを再利用できるとは書かれていない。推測で使わない。
async function undoCustomize(env, appId, backup) {
  const b = backup.body;
  const parts = [];
  let restored = false;
  let failed = false;
  let deployed = false;
  const urlsOf = (dev, kind) => ((b.customize && b.customize[dev] && b.customize[dev][kind]) || []).filter((e) => e.type === 'URL');
  const fileNames = [];
  for (const [dev, kind] of CUSTOMIZE_KEYS) {
    for (const e of ((b.customize && b.customize[dev] && b.customize[dev][kind]) || [])) {
      if (e.type === 'FILE') fileNames.push(`${dev}.${kind}:${e.name}`);
    }
  }
  try {
    const json = {
      app: appId,
      ...(b.scope ? { scope: b.scope } : {}),
      desktop: { js: urlsOf('desktop', 'js'), css: urlsOf('desktop', 'css') },
      mobile: { js: urlsOf('mobile', 'js'), css: urlsOf('mobile', 'css') },
    };
    await kintoneFetch(env, 'PUT', '/k/v1/preview/app/customize.json', { json });
    restored = true;
    parts.push({ name: 'customize', status: 'restored', message: '控えの URL 指定の JS/CSS を戻しました' });
  } catch (e) {
    failed = true;
    parts.push({ name: 'customize', status: 'failed', message: e.message });
  }
  if (fileNames.length) {
    parts.push({
      name: 'customize-files',
      status: 'cannot',
      message: `戻せません: アップロード済みのファイル(${fileNames.join(', ')})は戻せません(ファイルキーを控えていません)。画面から入れ直してください`,
    });
  }
  if (restored) {
    try {
      await deployAndWait(env, appId);
      deployed = true;
      parts.push({ name: 'deploy', status: 'restored', message: 'アプリ設定を反映しました' });
      try { renameSync(backup.file, backup.file.replace(/\.json$/, '.undone.json')); } catch { /* 印を付けられなくても続ける */ }
    } catch (e) {
      failed = true;
      parts.push({ name: 'deploy', status: 'failed', message: e.message });
    }
  } else {
    parts.push({ name: 'deploy', status: 'unchanged', message: '戻した物が無いので反映していません' });
  }
  return {
    ok: !failed,
    appId: String(appId),
    kind: 'customize',
    mode: env.mode || 'dev',
    backup: backup.file,
    restored,
    deployed,
    cannot: parts.filter((p) => p.status === 'cannot').map((p) => p.name),
    parts,
  };
}

// ---- CLI ----

function parseDeployFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ppk') {
      out.ppk = args[++i];
    } else if (args[i] === '--config') {
      out.configFile = args[++i];
    }
  }
  return out;
}

// 値を取るフラグと、真偽のフラグを分けて読む。位置引数と flags を返す
function parseFlags(args, valueFlags, boolFlags = []) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) {
      flags[a] = args[++i];
    } else if (boolFlags.includes(a)) {
      flags[a] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const splitList = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'pack') {
    // 手元で包むだけ。接続設定を読まない
    if (!rest[0]) {
      printJson({ ok: false, error: { message: 'pack: plugin-dir が必要です' } });
      return 2;
    }
    try {
      const out = await cmdPack(rest[0]);
      printJson(out);
      return out.ok ? 0 : 1;
    } catch (e) {
      printJson({ ok: false, error: { code: e.code, message: e.message } });
      return 2;
    }
  }
  let env;
  try {
    env = loadKinEnv();
  } catch (e) {
    if (e instanceof KinEnvError) {
      printJson({ ok: false, error: { code: e.code, message: e.message } });
      return 2;
    }
    throw e;
  }

  try {
    if (cmd === 'apps') {
      printJson(await cmdApps(env));
      return 0;
    }
    if (cmd === 'form') {
      const [appId] = rest;
      if (!appId) {
        printJson({ ok: false, error: { message: 'form: appId が必要です' } });
        return 2;
      }
      printJson(await cmdForm(env, appId));
      return 0;
    }
    if (cmd === 'deploy') {
      const [pluginDir, appId, ...flags] = rest;
      if (!pluginDir || !appId || !String(appId).split(',').some((x) => x.trim())) {
        printJson({ ok: false, error: { message: 'deploy: plugin-dir と appId(複数なら 1,2,3)が必要です。使い方: deploy <plugin-dir> <appId>[,<appId>...] [--ppk <path>] [--config <json-file>]' } });
        return 2;
      }
      const opts = parseDeployFlags(flags);
      const out = await cmdDeploy(env, pluginDir, appId, opts);
      printJson(out);
      if (!out.ok && out.error && out.error.code === 'prod_denied') return 2;
      return out.ok ? 0 : 1;
    }
    if (cmd === 'form-change') {
      const { positional, flags } = parseFlags(rest, ['--ops'], ['--plan']);
      if (!positional[0] || !flags['--ops']) {
        printJson({ ok: false, error: { message: 'form-change: appId と --ops <ops.json> が必要です。使い方: form-change <appId> --ops <ops.json> [--plan]' } });
        return 2;
      }
      const out = await cmdFormChange(env, positional[0], { opsFile: flags['--ops'], plan: Boolean(flags['--plan']) });
      printJson(out);
      if (out.ok) return 0;
      return out.error && ['bad_ops', 'not_supported', 'prod_denied'].includes(out.error.code) ? 2 : 1;
    }
    if (cmd === 'mode') {
      printJson(cmdMode(env, rest[0]));
      return 0;
    }
    if (cmd === 'status') {
      printJson(cmdStatus(env));
      return 0;
    }
    if (cmd === 'plugins' || cmd === 'backups') {
      const [appId] = rest;
      if (!appId) {
        printJson({ ok: false, error: { message: `${cmd}: appId が必要です` } });
        return 2;
      }
      printJson(cmd === 'plugins' ? await cmdPlugins(env, appId) : cmdBackups(env, appId));
      return 0;
    }
    if (cmd === 'records') {
      const { positional, flags } = parseFlags(rest, ['--query', '--limit', '--fields']);
      if (!positional[0]) {
        printJson({ ok: false, error: { message: 'records: appId が必要です' } });
        return 2;
      }
      printJson(await cmdRecords(env, positional[0], {
        query: flags['--query'], limit: flags['--limit'], fields: splitList(flags['--fields']),
      }));
      return 0;
    }
    if (cmd === 'customize') {
      const { positional, flags } = parseFlags(rest, ['--js', '--css', '--mobile-js', '--mobile-css'], ['--keep-urls']);
      if (!positional[0]) {
        printJson({ ok: false, error: { message: 'customize: appId が必要です' } });
        return 2;
      }
      const out = await cmdCustomize(env, positional[0], {
        js: splitList(flags['--js']),
        css: splitList(flags['--css']),
        mobileJs: splitList(flags['--mobile-js']),
        mobileCss: splitList(flags['--mobile-css']),
        keepUrls: Boolean(flags['--keep-urls']),
      });
      printJson(out);
      return out.ok ? 0 : 1;
    }
    if (cmd === 'undo') {
      const [appId] = rest;
      if (!appId) {
        printJson({ ok: false, error: { message: 'undo: appId が必要です' } });
        return 2;
      }
      const out = await cmdUndo(env, appId);
      printJson(out);
      return out.ok ? 0 : 1;
    }
    printJson({ ok: false, error: { message: `unknown command: ${cmd || '(none)'}` } });
    return 2;
  } catch (e) {
    printJson({ ok: false, error: { code: e.code, status: e.status, message: e.message } });
    return 2;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
