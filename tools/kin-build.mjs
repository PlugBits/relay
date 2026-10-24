#!/usr/bin/env node
// プラグインの手前のビルド(dev 用の別フォルダを作る等)を relay.config.json の build で回す CLI。
// 使い方:
//   node tools/kin-build.mjs <plugin-dir> [--check]
// relay.config.json の build: {command, dir}
//   command … プロジェクトの根(plugin-dir の 2 つ上 = plugins/ の親)で sh -c で実行する文字列(1〜400 字)
//   dir     … ビルド後に manifest.json があるべきフォルダ(根からの相対。根/plugins/ の下だけ)
// build が無ければ何もしない。--check は実行せずに中身だけ返す(通信なし)。
// 守り: env の値は出さない。出力は末尾 20 行だけ。タイムアウト 180 秒(RELAY_BUILD_TIMEOUT_MS でテスト用に変更可)。
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 180000;
const TAIL_LINES = 20;
const MAX_CAPTURE = 256 * 1024;

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function timeoutMs() {
  const n = Number(process.env.RELAY_BUILD_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function tailOf(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-TAIL_LINES).join('\n');
}

function within(parent, child) {
  return child === parent || child.startsWith(parent + sep);
}

// build を取り出して検証する。{build:null} / {build:{command,dir,abs}} / {error}
function loadBuild(pluginDir) {
  const cfgPath = join(pluginDir, 'relay.config.json');
  if (!existsSync(cfgPath)) return { build: null };
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    return { error: fail('bad_config', `relay.config.json を読めません: ${e.message}`) };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { error: fail('bad_config', 'relay.config.json は JSON のオブジェクトにしてください') };
  }
  if (cfg.build === undefined || cfg.build === null) return { build: null };
  const b = cfg.build;
  if (typeof b !== 'object' || Array.isArray(b)) {
    return { error: fail('bad_config', 'build は {command, dir} のオブジェクトにしてください') };
  }
  if (typeof b.command !== 'string' || b.command.length < 1 || b.command.length > 400) {
    return { error: fail('bad_config', 'build.command は 1〜400 字の文字列にしてください') };
  }
  if (typeof b.dir !== 'string' || b.dir.length < 1) {
    return { error: fail('bad_config', 'build.dir は文字列(プロジェクトの根からの相対パス)にしてください') };
  }
  const root = dirname(dirname(pluginDir));
  const plugins = join(root, 'plugins');
  const abs = resolve(root, b.dir);
  if (!within(plugins, abs) || abs === plugins) {
    return { error: fail('bad_config', `build.dir は ${plugins}/ の下だけ指定できます`) };
  }
  // 既にある場合はシンボリックリンクで外へ出ていないかを実体で確かめる
  if (existsSync(abs) && !realDirOk(root, abs)) {
    return { error: fail('bad_config', `build.dir が ${plugins}/ の外を指しています(リンク)`) };
  }
  return { build: { command: b.command, dir: abs }, root };
}

function realDirOk(root, abs) {
  try {
    return within(realpathSync(join(root, 'plugins')), realpathSync(abs));
  } catch {
    return false;
  }
}

function runCommand(command, cwd, limitMs) {
  return new Promise((done) => {
    let buf = '';
    let timedOut = false;
    const child = spawn('sh', ['-c', command], {
      cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const onData = (d) => {
      buf += d.toString();
      if (buf.length > MAX_CAPTURE) buf = buf.slice(-MAX_CAPTURE);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 既に終わっている */ }
    }, limitMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: -1, timedOut, output: `${buf}\n${e.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: code === null ? -1 : code, signal, timedOut, output: buf });
    });
  });
}

export async function cmdBuild(pluginDirArg, { check = false } = {}) {
  const pluginDir = resolve(pluginDirArg);
  const loaded = loadBuild(pluginDir);
  if (loaded.error) return loaded.error;
  if (!loaded.build) {
    return check ? { ok: true, build: null } : { ok: true, built: false, dir: pluginDir };
  }
  const { command, dir } = loaded.build;
  if (check) return { ok: true, build: { command, dir } };

  const t0 = Date.now();
  const limit = timeoutMs();
  const r = await runCommand(command, loaded.root, limit);
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const tail = tailOf(r.output);
  if (r.timedOut) {
    return fail('build_failed', `ビルドが ${Math.round(limit / 1000)} 秒で終わらず止めました`, { tail });
  }
  if (r.code !== 0) {
    return fail('build_failed', `ビルドが失敗しました(終了コード ${r.code}${r.signal ? ` / ${r.signal}` : ''})`, { tail });
  }
  if (!existsSync(join(dir, 'manifest.json'))) {
    return fail('no_manifest', `ビルド後の ${dir} に manifest.json がありません`, { tail });
  }
  if (!realDirOk(loaded.root, dir)) {
    return fail('bad_config', `build.dir が ${join(loaded.root, 'plugins')}/ の外を指しています(リンク)`, { tail });
  }
  return { ok: true, built: true, dir, seconds, tail };
}

export async function main(argv) {
  const check = argv.includes('--check');
  const positional = argv.filter((a) => a !== '--check');
  if (!positional[0]) {
    printJson(fail(undefined, 'build: plugin-dir が必要です'));
    return 2;
  }
  try {
    const out = await cmdBuild(positional[0], { check });
    printJson(out);
    return out.ok ? 0 : 1;
  } catch (e) {
    printJson({ ok: false, error: { code: e.code, message: e.message } });
    return 2;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
