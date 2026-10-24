#!/usr/bin/env node
// この mod の動作条件を診断する。何もインストールしない(読むだけ)。
//   node tools/kin-doctor.mjs   → {ok, checks:[{name, ok, message, fix?, warn?}]}
// warn:true の項目は無くても deploy は動く(画面チェックだけ省略)。ok 全体の判定には入れない。
// テスト用: RELAY_PROBE_BASE で検査の宛先を差し替え、RELAY_CHROMIUM で chromium の場所を明示できる。
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cmdStatus, probeHost, ProfileError } from './kin-profile.mjs';

const CHROMIUM_FIX = '画面チェックを使うなら: npx playwright install chromium(この mod は自動では入れません)';

// プラグインの根(tools/ の1つ上)。marketplace 経由の導入は node_modules が無いので、まず依存の有無を見る
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPS = ['@kintone/plugin-packer', 'playwright'];
// node の解決と同じに、根から上へ node_modules/<pkg>/package.json を探す(依存を import せずに確かめる)
function hasPackage(pkg, from = ROOT) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', pkg, 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

export async function runDoctor({ fetchImpl } = {}) {
  const checks = [];
  const add = (name, ok, message, fix, warn) => {
    const c = { name, ok, message };
    if (fix) c.fix = fix;
    if (warn) c.warn = true;
    checks.push(c);
  };

  const missing = DEPS.filter((d) => !hasPackage(d));
  add('deps', missing.length === 0,
    missing.length === 0 ? `依存(${DEPS.join('・')})があります` : `依存が入っていません: ${missing.join('・')}`,
    missing.length === 0 ? undefined : `端末で: cd ${ROOT} && npm ci --omit=dev(この mod は自動では入れません)`);

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20, `Node ${process.versions.node}`, major >= 20 ? undefined : 'Node 20 以上を入れてください');

  let status = null;
  try {
    status = cmdStatus();
  } catch (e) {
    status = { ok: false, error: { code: e instanceof ProfileError ? e.code : 'failed', message: e instanceof ProfileError ? e.message : '接続先を読めませんでした' } };
  }
  if (status.ok) {
    add('connection', true, `${status.name || status.active || '接続先'}(${status.host}・${status.mode === 'prod' ? '本番' : '開発'})`);
  } else {
    add('connection', false, status.error.message, '「/kin setup」で接続先を設定してください');
  }

  if (status.ok) {
    const p = await probeHost(status.host, fetchImpl ? { fetchImpl } : {});
    add('reachable', p.code === 401, p.message, p.code === 401 ? undefined :
      p.code === 404 ? 'サブドメインを確認してください(「/kin setup」)' : 'ネットワークとホスト名を確認してください');
  } else {
    add('reachable', false, '接続先が無いので確認できません', '先に「/kin setup」');
  }

  let chromium = null;
  try {
    ({ chromium } = await import('playwright'));
    add('playwright', true, 'playwright を読み込めます');
  } catch {
    add('playwright', false, 'playwright を読み込めません(画面チェックだけ省略されます。deploy は動きます)',
      `端末で: cd ${ROOT} && npm ci --omit=dev(この mod は自動では入れません)`, true);
  }

  const explicit = process.env.RELAY_CHROMIUM;
  let exe = '';
  if (explicit) exe = explicit;
  else if (chromium) { try { exe = chromium.executablePath(); } catch { exe = ''; } }
  if (exe && existsSync(exe)) {
    add('chromium', true, `chromium があります${explicit ? '(RELAY_CHROMIUM)' : ''}`);
  } else {
    add('chromium', false, '画面チェックに必要な chromium がありません(deploy は動きます。画面チェックは省略されます)', CHROMIUM_FIX, true);
  }

  const libs = process.env.RELAY_NATIVE_LIBS;
  if (libs) {
    const ok = existsSync(libs);
    add('native-libs', ok, ok ? 'RELAY_NATIVE_LIBS のフォルダがあります' : 'RELAY_NATIVE_LIBS のフォルダがありません',
      ok ? undefined : 'RELAY_NATIVE_LIBS のパスを直すか、外してください', true);
  }

  return { ok: checks.every((c) => c.ok || c.warn), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await runDoctor();
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exitCode = out.ok ? 0 : 1;
}
