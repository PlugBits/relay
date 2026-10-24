#!/usr/bin/env node
// テスト用レコードの作成・掃除。作った id だけを記録して、記録した id だけを消す(開発環境だけ)。
//   node tools/kin-records.mjs write <appId> --rows <file.json> --tag <tag>
//   node tools/kin-records.mjs cleanup <appId> [--tag <tag>]
//   node tools/kin-records.mjs list <appId>     (読むだけ・通信しない・本番でも可)
// 記録: <backupRoot()>/<host>/<appId>/test-records.json  {items:[{id, tag, at}]}(ディレクトリ 700・ファイル 600)
// 最後の行が JSON。エラーは {ok:false, error:{code,message}}。パスワード・認証ヘッダーは出さない。
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadKinEnv, KinEnvError } from './kin-env.mjs';
import { kintoneFetch, backupRoot } from './kin-loop.mjs';

const MAX_ROWS = 20;
const DELETE_BATCH = 100;
const TAG_RE = /^[A-Za-z0-9_-]{1,40}$/;

class RecordsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function appDir(env, appId) {
  return join(backupRoot(), new URL(env.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_'), String(appId));
}

function checkAppId(appId) {
  if (!/^\d+$/.test(String(appId || ''))) throw new RecordsError('bad_input', 'appId は数字で指定してください');
}

function denyProd(env, what) {
  if (env.mode === 'prod') {
    throw new RecordsError('prod_denied', `本番では${what}できません(開発環境だけ)`);
  }
}

function readItems(file) {
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    throw new RecordsError('bad_record_file', `${file} が読めません(壊れています)`);
  }
}

function writeItems(dir, file, items) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(file, `${JSON.stringify({ items }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// rows の1行を kintone の形に。値が {value} を持つ形ならそのまま
function toRecord(row, i) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new RecordsError('bad_input', `rows の ${i + 1} 行目がオブジェクトではありません`);
  }
  const rec = {};
  for (const [code, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) rec[code] = v;
    else if (v === null || typeof v === 'object' && !Array.isArray(v)) {
      throw new RecordsError('bad_input', `rows の ${i + 1} 行目 ${code}: 文字列・数値・配列だけ使えます`);
    } else rec[code] = { value: v };
  }
  return rec;
}

export async function cmdWrite(env, appId, { rowsFile, tag } = {}) {
  denyProd(env, '書き込み');
  checkAppId(appId);
  if (!tag || !TAG_RE.test(tag)) throw new RecordsError('bad_input', 'tag は英数字・_・- の 1〜40 文字で指定してください');
  if (!rowsFile) throw new RecordsError('bad_input', '--rows <file.json> が必要です');
  let rows;
  try {
    rows = JSON.parse(readFileSync(rowsFile, 'utf8'));
  } catch (e) {
    throw new RecordsError('bad_input', `rows のファイルが読めません: ${e.code || 'JSON が不正です'}`);
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new RecordsError('bad_input', 'rows は 1 行以上の配列にしてください');
  if (rows.length > MAX_ROWS) throw new RecordsError('too_many_rows', `一度に作れるのは ${MAX_ROWS} 行までです(${rows.length} 行)`);
  const records = rows.map(toRecord);

  const res = await kintoneFetch(env, 'POST', '/k/v1/records.json', { json: { app: appId, records } });
  const ids = (res.ids || []).map(String);
  const dir = appDir(env, appId);
  const file = join(dir, 'test-records.json');
  const at = new Date().toISOString();
  writeItems(dir, file, [...readItems(file), ...ids.map((id) => ({ id, tag, at }))]);
  return { ok: true, mode: env.mode, appId: String(appId), tag, ids, file };
}

// 一括で消す。既に無い id で失敗したら 1 件ずつ。{deleted:[], missing:[]}
async function deleteIds(env, appId, ids) {
  const deleted = [];
  const missing = [];
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const chunk = ids.slice(i, i + DELETE_BATCH);
    try {
      await kintoneFetch(env, 'DELETE', '/k/v1/records.json', { query: { app: appId, ids: chunk } });
      deleted.push(...chunk);
    } catch (e) {
      if (!(e.status >= 400 && e.status < 500)) throw e;
      for (const id of chunk) {
        try {
          await kintoneFetch(env, 'DELETE', '/k/v1/records.json', { query: { app: appId, ids: [id] } });
          deleted.push(id);
        } catch (e2) {
          if (e2.status === 404 || e2.code === 'GAIA_RE01' || e2.status === 400) missing.push(id);
          else throw e2;
        }
      }
    }
  }
  return { deleted, missing };
}

export async function cmdCleanup(env, appId, { tag } = {}) {
  denyProd(env, '掃除');
  checkAppId(appId);
  if (tag !== undefined && !TAG_RE.test(tag)) throw new RecordsError('bad_input', 'tag は英数字・_・- の 1〜40 文字で指定してください');
  const dir = appDir(env, appId);
  const file = join(dir, 'test-records.json');
  const items = readItems(file);
  const target = items.filter((it) => tag === undefined || it.tag === tag);
  const keep = items.filter((it) => !target.includes(it));
  const ids = target.map((it) => String(it.id));
  let result = { deleted: [], missing: [] };
  try {
    result = await deleteIds(env, appId, ids);
  } finally {
    // 途中で止まっても、消せたものは記録から外す
    if (ids.length) {
      const gone = new Set([...result.deleted, ...result.missing]);
      writeItems(dir, file, [...keep, ...target.filter((it) => !gone.has(String(it.id)))]);
    }
  }
  const remaining = readItems(file).length;
  return { ok: true, appId: String(appId), deleted: result.deleted.length, missing: result.missing.length, remaining };
}

export function cmdList(env, appId) {
  checkAppId(appId);
  const items = readItems(join(appDir(env, appId), 'test-records.json'));
  const tags = {};
  for (const it of items) tags[it.tag] = (tags[it.tag] || 0) + 1;
  return { ok: true, appId: String(appId), count: items.length, tags };
}

function parseFlags(args, valueFlags) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.includes(args[i])) flags[args[i]] = args[++i];
    else positional.push(args[i]);
  }
  return { positional, flags };
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!['write', 'cleanup', 'list'].includes(cmd)) {
    printJson({ ok: false, error: { code: 'bad_input', message: `unknown command: ${cmd || '(none)'}` } });
    return 2;
  }
  const { positional, flags } = parseFlags(rest, ['--rows', '--tag']);
  if (!positional[0]) {
    printJson({ ok: false, error: { code: 'bad_input', message: `${cmd}: appId が必要です` } });
    return 2;
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
    if (cmd === 'write') {
      printJson(await cmdWrite(env, positional[0], { rowsFile: flags['--rows'], tag: flags['--tag'] }));
    } else if (cmd === 'cleanup') {
      printJson(await cmdCleanup(env, positional[0], { tag: flags['--tag'] }));
    } else {
      printJson(cmdList(env, positional[0]));
    }
    return 0;
  } catch (e) {
    printJson({ ok: false, error: { code: e.code, status: e.status, message: e.message } });
    return e instanceof RecordsError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
