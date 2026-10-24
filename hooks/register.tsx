// プラグイン作成 mod: kintone プラグイン開発ループの Claude Code mod(薄い皮)。
// 実処理は tools/*.mjs(kin-loop = REST、kin-probe = playwright)。mod は $.process.spawn で呼ぶだけ。
// kintone.env は tools だけが読む。mod は認証情報に触れない・pane にも出さない。
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RelayLine } from '../types'
import {
  buildFailure,
  digestApps,
  digestForm,
  digestFormChange,
  digestProbe,
  digestUndo,
  formatApps,
  formatConnStatus,
  formatDeploy,
  formatDoctor,
  formatForm,
  formatFormChange,
  formatProbe,
  formatProfiles,
  formatSaveResult,
  formatUndo,
  isAppId,
  isProdKind,
  mdConnStatus,
  mdDoctor,
  mdProfiles,
  parseAppNumbers,
  scrub,
  SETUP_NEEDED,
  mdBackups,
  mdDeployMulti,
  mdDeployResult,
  mdNextCleanup,
  planList,
  planWarnings,
  mdPlugins,
  parseLastJson,
  pickStatus,
  redact,
  reportFromDeployFailure,
  reportFromProbe,
  reportFromUndo,
  resolveUnder,
  safeJson,
  toolError,
  DEPS_MESSAGE,
  isDepsMissing,
  mdNextConfig,
  mdNextForModel,
  mdNextList,
  logNextList,
  mdNextPack,
  mdNextProd,
  mdNextShot,
  mdNextUrls,
  NEXT_CREATE,
  nextItems,
  NEXT_OFF,
  parseNextNumber,
  formHead,
} from './format'
import type { NextState } from './format'
import type { BandView, EventRow, FormMapData, GateView, HeadView, Pulse, ScreenPage, ScreenShot } from './views'
import { renderHead, renderTiles } from './head'
import { foldRow, GAP_INNER, GAP_SECTION, sectionHead } from './section'
import { renderResultCard, resultCard } from './result'
import { createPrompt, fixPrompt, renderAppButtons, renderAppCards, renderStart, START_COMPOSE } from './start'
import type { StartStep } from './start'
import { renderScreen } from './screen'
import { renderEvents } from './events'
import { gateLines, renderGate } from './gate'
import { BAND_GUIDE, bandText, renderBand } from './band'
import { applyBuild, applyDeploy, applyProbe, attachSnippets, failPulse, fixPromptText, initPulse, renderPulse } from './pulse'
import { renderFormMap } from './formmap'

const PANE = 'relay'
const DEBOUNCE_MS = 500

// $.state 専用の参照(plugin と key はリテラル)
const target = atom({ plugin: 'plugbits-relay', key: 'target' } as const, '')
const main = atom({ plugin: 'plugbits-relay', key: 'main' } as const, [] as RelayLine[], {
  shape: 'lines-1',
})
const loop = atom({ plugin: 'plugbits-relay', key: 'loop' } as const, [] as RelayLine[], {
  shape: 'lines-1',
})
const report = atom({ plugin: 'plugbits-relay', key: 'report' } as const, '')
// ② pane と同じ内容の短い Markdown(次のプロンプトの context に載せる)。kind が同じものは新しい方で置き換える
type Digest = { kind: string; md: string }
const digest = atom({ plugin: 'plugbits-relay', key: 'digest' } as const, [] as Digest[], { shape: 'digest-1' })
// ① 本番への反映/undo の確認待ち(JSON 文字列。空なら無し)。最新の保存で置き換える
type CustomizeArgs = { js: string[]; css: string[]; mobileJs: string[]; mobileCss: string[] }
type Pending = {
  kind: 'deploy' | 'undo' | 'customize' | 'use' | 'form'
  appId: string
  dir?: string
  name?: string
  customize?: CustomizeArgs
  profileId?: string
  // form: 実行する ops(適用の時に同じものを渡す)と、確認に出した変更の一覧
  ops?: unknown[]
  plan?: string[]
}
const confirm = atom({ plugin: 'plugbits-relay', key: 'confirm' } as const, '')
// kin-loop が教えてくれた接続先のモード('dev' | 'prod')。pane の見出し用
const envMode = atom({ plugin: 'plugbits-relay', key: 'envMode' } as const, '')
// 反映の後の「次の一手」(JSON 文字列。空なら出ていない)。認証情報・設定値は入れない
const nextAtom = atom({ plugin: 'plugbits-relay', key: 'next' } as const, '')
async function readNext($: EngineInterface): Promise<NextState | null> {
  const raw = await read($, nextAtom)
  if (!raw) return null
  try {
    return JSON.parse(raw) as NextState
  } catch {
    return null
  }
}
const clearNext = ($: EngineInterface) => update($, nextAtom, () => '')
// /kin setup の pane の見た目(JSON 文字列。パスワードは入れない。入力中の文字は下の form に置く)
const setup = atom({ plugin: 'plugbits-relay', key: 'setup' } as const, '')
// v0.9: 反映の鼓動(直近1回)・フォームの地図・帯の接続先。どれも JSON 文字列
const pulseAtom = atom({ plugin: 'plugbits-relay', key: 'pulse' } as const, '')
const formMapAtom = atom({ plugin: 'plugbits-relay', key: 'formMap' } as const, '')
const connAtom = atom({ plugin: 'plugbits-relay', key: 'conn' } as const, '')
const formOpenAtom = atom({ plugin: 'plugbits-relay', key: 'formOpen' } as const, '')
// v1.0 pane の見た目(画面の切り替え・フォームの開閉・全部見る・詳細の開閉)と、帯の [戻す]
const paneUiAtom = atom({ plugin: 'plugbits-relay', key: 'paneUi' } as const, '')
const undoOfferAtom = atom({ plugin: 'plugbits-relay', key: 'undoOffer' } as const, '')
type PaneUi = { screen: ScreenPage; form: boolean; all: boolean; detail: boolean; evAll: boolean; conn: boolean; pick: boolean }
const PANE_UI: PaneUi = { screen: 'index', form: true, all: false, detail: false, evAll: false, conn: false, pick: false }
// v1.1 はじめに(反映先が未選択の時だけ pane に出す)。アプリ一覧・プラグイン名だけ(ID・ホストは持たない)
const startAtom = atom({ plugin: 'plugbits-relay', key: 'start' } as const, '')
const readPaneUi = async ($: EngineInterface): Promise<PaneUi> => ({ ...PANE_UI, ...parseOr<Partial<PaneUi>>(await read($, paneUiAtom), {}) })
const patchPaneUi = ($: EngineInterface, f: (v: PaneUi) => PaneUi) =>
  update($, paneUiAtom, raw => JSON.stringify(f({ ...PANE_UI, ...parseOr<Partial<PaneUi>>(raw, {}) })))
function parseOr<T>(raw: string, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
const readPulse = async ($: EngineInterface) => parseOr<Pulse | null>(await read($, pulseAtom), null)
async function patchPulse($: EngineInterface, f: (p: Pulse) => Pulse) {
  const p = await readPulse($)
  if (p) await update($, pulseAtom, () => JSON.stringify(f(p)))
}
// 結果欄(pane)。鼓動が無ければ結果だけの入れ物を作る
async function setResult($: EngineInterface, title: string, md: string) {
  const p = (await readPulse($)) ?? { name: '', appId: '', startedAt: Date.now(), stages: [], errors: [] }
  await update($, pulseAtom, () => JSON.stringify({ ...p, result: { title, md: redact(md) } }))
}
const readStart = async ($: EngineInterface) => parseOr<StartStep>(await read($, startAtom), { step: 'menu' })
const setStart = ($: EngineInterface, v: StartStep) => update($, startAtom, () => JSON.stringify(v))
// ①② アプリ一覧を読んで選ばせる。読み終わる前に戻る・別の段に進んでいたら書かない
async function startApps($: EngineInterface, step: 'create' | 'fix') {
  await setStart($, { step, apps: null })
  const r = await runToolSafe($, 'kin-loop.mjs', ['apps'])
  const apps = r.json?.ok
    ? ((r.json.apps ?? []) as Record<string, unknown>[]).map(a => ({ id: String(a.appId ?? ''), name: String(a.name ?? '') })).filter(a => /^\d+$/.test(a.id))
    : []
  if (r.json?.mode) await update($, envMode, () => String(r.json?.mode))
  if ((await readStart($)).step === step) await setStart($, { step, apps })
}
// ② 選んだアプリに付いているプラグイン名(名前だけ)
async function startPlugins($: EngineInterface, appId: string) {
  const cur = await readStart($)
  const appName = cur.step === 'fix' ? cur.apps?.find(a => a.id === appId)?.name : undefined
  const base = { step: 'fix-plugin' as const, appId, ...(appName ? { appName } : {}) }
  await setStart($, { ...base, plugins: null })
  const r = await runToolSafe($, 'kin-loop.mjs', ['form', appId])
  const plugins = r.json?.ok ? ((r.json.plugins ?? []) as Record<string, unknown>[]).map(p => String(p.name ?? '')).filter(Boolean) : []
  const now = await readStart($)
  if (now.step === 'fix-plugin' && now.appId === appId) await setStart($, { ...base, plugins })
}
// ③ と頭の「開発 ▾」: 接続先の一覧(名前・開発/本番・ドメイン)を pane に開く
async function toggleConn($: EngineInterface) {
  const ui = await readPaneUi($)
  await patchPaneUi($, v => ({ ...v, conn: !ui.conn }))
  if (!ui.conn) await refreshProfiles($)
}

// v1.0 縮小の中身(base64)。描くたびに読まない。古い物は捨てる(直近の反映の3枚だけ持つ)
const thumbCache = new Map<string, string>()
async function thumbBase64($: EngineInterface, path: string): Promise<string | null> {
  const hit = thumbCache.get(path)
  if (hit) return hit
  const r = await $.fs.read(path, { as: 'bytes' }).catch(() => null)
  const b64 = r && typeof r === 'object' && 'base64' in r ? String(r.base64) : null
  if (!b64) return null
  if (thumbCache.size >= 3) thumbCache.delete(thumbCache.keys().next().value!)
  thumbCache.set(path, b64)
  return b64
}

async function bandView($: EngineInterface): Promise<BandView> {
  const conn = parseOr<BandView['conn']>(await read($, connAtom), null)
  const appId = await read($, target)
  const fm = parseOr<FormMapData | null>(await read($, formMapAtom), null)
  const p = await readPulse($)
  const pend = await readPending($)
  return {
    conn,
    app: appId ? { id: appId, ...(fm?.appId === appId && fm.appName ? { name: fm.appName } : {}) } : null,
    // 失敗は反映までの段だけで見る(画面のエラーはエラー数の側に出る)
    last: p?.finishedAt ? { at: p.finishedAt, seconds: p.totalSeconds ?? 0, ok: !p.stages.some(st => st.key !== 'check' && st.status === 'err') } : null,
    errors: p?.errors.length ?? 0,
    pending: pend ? { headline: pendingHeadline(pend), okLabel: pend.kind === 'use' ? '切り替える' : pend.kind === 'form' ? '実行' : '反映' } : null,
    undo: !pend && (await read($, undoOfferAtom)) ? { appId: await read($, undoOfferAtom) } : null,
  }
}
async function setConn($: EngineInterface, name: string, kind: string) {
  await update($, connAtom, () => (name ? JSON.stringify({ name, kind: isProdKind(kind) ? 'prod' : 'dev' }) : ''))
}

type SetupView = {
  open: boolean
  rev: number
  busy: boolean
  lines: RelayLine[]
  saved: { id: string; active: boolean } | null
  profiles: { id: string; name: string; host: string; kind: string; active: boolean }[]
}
const EMPTY_SETUP: SetupView = { open: false, rev: 0, busy: false, lines: [], saved: null, profiles: [] }
async function readSetup($: EngineInterface): Promise<SetupView> {
  try {
    return { ...EMPTY_SETUP, ...(JSON.parse((await read($, setup)) || '{}') as Partial<SetupView>) }
  } catch {
    return EMPTY_SETUP
  }
}
async function patchSetup($: EngineInterface, f: (v: SetupView) => SetupView) {
  const v = f(await readSetup($))
  await update($, setup, () => JSON.stringify({ ...v, rev: v.rev + 1 }))
}

// 入力欄の中身。パスワードはここ(モジュールの変数)だけ。$.state・会話・toast・ログには置かない。保存の瞬間に空にする
const DOMAINS = ['cybozu.com', 'kintone.com', 'cybozu.cn']
const blankForm = () => ({ name: '', subdomain: '', domain: 'cybozu.com', username: '', password: '', kind: 'dev', apps: '' })
let form = blankForm()
// 保存済みのパスワードを送ったか(真偽だけ。値は持たない)。欄に「設定済み」と出すため
let pwSent = false

// 子プロセスの上限(秒): 反映・戻す・カスタマイズ 60(複数アプリの反映・フォーム変更の実行 120)、ビルド 200、画面チェック 120(手順つき 240)、ほかは 30
function timeoutFor(script: string, args: string[]): number {
  if (script === 'kin-probe.mjs') return args.includes('--actions') ? 240 : 120
  if (script === 'kin-build.mjs') return 200
  if (script === 'kin-loop.mjs' && args[0] === 'deploy') return (args[2] ?? '').includes(',') ? 120 : 60
  if (script === 'kin-loop.mjs' && args[0] === 'form-change') return args.includes('--plan') ? 30 : 120
  if (script === 'kin-loop.mjs' && ['undo', 'customize'].includes(args[0] ?? '')) return 60
  return 30
}

const DIGEST_KEEP = 3
async function pushDigest($: EngineInterface, kind: string, md: string) {
  await update($, digest, (list): Digest[] => [...list.filter(d => d.kind !== kind), { kind, md }].slice(-DIGEST_KEEP))
}

type Raw = { stdout: string; stderr: string; code: number | null; timedOut?: number }

// `plugins/<name>/…` 配下のファイルなら { dir, name }。dir は渡された綴りのまま(相対でも絶対でも)
function pluginOf(filePath: string): { dir: string; name: string } | null {
  const m = /^(.*?(?:^|\/)plugins\/([^/]+))\/(.+)$/.exec(filePath)
  if (!m) return null
  const [, dir, name, rest] = m
  if (!dir || !name || !rest) return null
  if (/^(node_modules|\.keys)\//.test(rest) || name === 'node_modules') return null
  return { dir, name }
}

// 同時に 2 本の deploy を走らせない: 連続した保存は Set にまとめ、1 本ずつ流す
const pending = new Set<string>()
// 道具・自動反映のどちらでも、プラグインごとの最後の反映時刻。保存の自動反映が直後に重ならないように
// key = プラグイン名
const toolDeployedAt = new Map<string, number>()
const DEDUPE_MS = 3000
const isRecentToolDeploy = (name: string) => Date.now() - (toolDeployedAt.get(name) ?? 0) < DEDUPE_MS
let isPumping = false
let nodeBin: string | undefined

// $.process.spawn で子を走らせ、出力を集める。起動できなければ throw。
// timeoutSec を過ぎたら子を止めて(ループを抜けると子が殺される)「時間切れ(N 秒)」を返す。input は子の標準入力(パスワードの通り道)
const TIMED_OUT = Symbol('timeout')
async function collect(
  $: EngineInterface,
  argv: string[],
  opts: { timeoutSec?: number; input?: string } = {},
): Promise<Raw> {
  const secs = opts.timeoutSec ?? 30
  const stream = $.process.spawn(opts.input === undefined ? { argv } : { argv, input: opts.input })
  let stdout = ''
  let stderr = ''
  const it = stream[Symbol.asyncIterator]()
  const stop = new AbortController()
  const timer: Promise<typeof TIMED_OUT> = $.clock.sleep(secs * 1000, { signal: stop.signal }).then(
    () => TIMED_OUT,
    () => new Promise<never>(() => undefined),
  )
  try {
    for (;;) {
      const pull = it.next()
      pull.catch(() => undefined)
      const step = await Promise.race([pull, timer])
      if (step === TIMED_OUT) {
        void Promise.resolve(it.return?.(undefined as never)).catch(() => undefined)
        return { stdout: '', stderr: `時間切れ(${secs} 秒)`, code: null, timedOut: secs }
      }
      if (step.done) return { stdout, stderr, code: step.value?.code ?? null }
      if (step.value.stream === 'stdout') stdout += step.value.text
      else stderr += step.value.text
    }
  } finally {
    stop.abort()
  }
}

// node の場所。常駐機の PATH に nvm が無いことがあるので、`node` → ~/.nvm の新しい順に試す
async function findNode($: EngineInterface): Promise<string> {
  if (nodeBin) return nodeBin
  if (await isNode20($, 'node')) {
    nodeBin = 'node'
    return nodeBin
  }
  // PATH に node が無い(systemd 起動など)なら nvm の新しい順
  try {
    const home = await $.env.get('HOME')
    if (home) {
      const dir = `${home}/.nvm/versions/node`
      const entries = await $.fs.list(dir)
      const versions = entries
        .map(en => en.name)
        .filter(n => /^v\d+\.\d+\.\d+$/.test(n))
        .sort((a, b) => {
          const pa = a.slice(1).split('.').map(Number)
          const pb = b.slice(1).split('.').map(Number)
          return (pb[0] ?? 0) - (pa[0] ?? 0) || (pb[1] ?? 0) - (pa[1] ?? 0) || (pb[2] ?? 0) - (pa[2] ?? 0)
        })
      for (const v of versions) {
        const bin = `${dir}/${v}/bin/node`
        if (await isNode20($, bin)) {
          nodeBin = bin
          return bin
        }
      }
    }
  } catch {
    /* nvm が無ければ下の失敗へ */
  }
  throw new Error('Node 20 以上が見つかりません(PATH の node と ~/.nvm/versions/node/*/bin/node を試しました)')
}

async function isNode20($: EngineInterface, bin: string): Promise<boolean> {
  try {
    const r = await collect($, [bin, '--version'])
    return r.code === 0 && Number(/^v(\d+)/.exec(r.stdout.trim())?.[1] ?? 0) >= 20
  } catch {
    return false
  }
}

async function runTool(
  $: EngineInterface,
  script: string,
  args: string[],
  input?: string,
): Promise<{ json: ReturnType<typeof parseLastJson>; raw: Raw }> {
  const node = await findNode($)
  const raw = await collect($, [node, `${$.plugin.root}/tools/${script}`, ...args], { timeoutSec: timeoutFor(script, args), ...(input === undefined ? {} : { input }) })
  if (!raw.timedOut && isDepsMissing(raw)) {
    // 依存が無い(npm ci 前)。生のエラーの代わりに案内を、pane・道具・次の発話の全部に同じ形で渡す
    return { json: { ok: false, error: { code: 'deps_missing', message: DEPS_MESSAGE } }, raw: { ...raw, stderr: DEPS_MESSAGE, stdout: '' } }
  }
  return { json: raw.timedOut ? null : parseLastJson(raw.stdout), raw }
}

// 起動できない等の例外も pane に出せる形にする
const failRaw = (e: unknown): Raw => ({ stdout: '', stderr: redact(e instanceof Error ? e.message : String(e)), code: null })

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'プラグイン作成 mod' })
}

type ToolOut = { json: ReturnType<typeof parseLastJson>; raw: Raw }

async function runToolSafe($: EngineInterface, script: string, args: string[], input?: string): Promise<ToolOut> {
  try {
    return await runTool($, script, args, input)
  } catch (e) {
    return { json: null, raw: failRaw(e) }
  }
}

// 反映・undo を 1 本ずつ流す(確認ボタンと保存の自動反映が重ならないように)
let running: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = running.then(fn, fn)
  running = next.catch(() => undefined)
  return next
}

// mode は通信しない。dev → 'dev'、prod で許可アプリ → 'prod'、拒否・読めない → 'denied'(行は pane 用)
async function checkMode(
  $: EngineInterface,
  appId: string,
): Promise<{ kind: 'dev' | 'prod' } | { kind: 'denied'; out: ToolOut }> {
  const out = await runToolSafe($, 'kin-loop.mjs', ['mode', appId])
  if (out.json?.ok && (out.json.mode === 'dev' || out.json.mode === 'prod')) {
    await update($, envMode, () => String(out.json?.mode))
    return { kind: out.json.mode }
  }
  return { kind: 'denied', out }
}

async function showDenied($: EngineInterface, title: string, out: ToolOut) {
  const lines = [{ text: title, tone: 'head' as const }, ...formatDeploy(title, out.json, out.raw).slice(1)]
  await update($, loop, (): RelayLine[] => lines)
  const msg = redact(String(out.json?.error?.message ?? out.raw.stderr ?? '').split('\n')[0] ?? '')
  await update($, report, () => redact(`mod からの報告: ${title} は止めました ${msg}`).slice(0, 300))
  $.ui.toast(`✗ ${title}`)
}

async function runOne($: EngineInterface, dir: string, name: string) {
  const appId = await read($, target)
  if (!appId) {
    await update($, loop, (): RelayLine[] => [
      { text: `${name} を保存しました`, tone: 'head' },
      { text: '反映先のアプリが未設定です。先に /kin <appId> を実行してください', tone: 'err' },
    ])
    await openPane($)
    return
  }
  await openPane($)
  const m = await checkMode($, appId)
  if (m.kind === 'denied') {
    await showDenied($, `${name} の反映(アプリ ${appId})`, m.out)
    return
  }
  if (m.kind === 'prod') {
    // 本番: すぐには反映しない。確認(ボタン / `/kin ok`)を待つ。新しい保存は前の確認待ちを置き換える
    await setPending($, { kind: 'deploy', appId, dir, name })
    return
  }
  await exclusive(() => deployNow($, dir, name, appId))
}

// v1.0 本番の関所: pane の上に小さなダイアログ(focus・Esc で閉じる=やめる)。開発のフォーム変更は pane の確認だけ
const GATE = 'relay-gate'
let gateView: GateView | null = null
async function openGate($: EngineInterface, p: Pending) {
  if (p.kind === 'form' && (await read($, envMode)) !== 'prod') return
  const pick = (j: Record<string, any> | null) => ((j?.backups ?? []) as Record<string, any>[]).find(b => !b.undone && b.createdAt)
  const [ver, bk, fm] = await Promise.all([
    p.dir ? $.fs.read(`${p.dir}/manifest.json`).then(t => String(JSON.parse(t)?.version ?? ''), () => '') : Promise.resolve(''),
    p.kind === 'use' ? Promise.resolve(null) : runToolSafe($, 'kin-loop.mjs', ['backups', p.appId]).then(r => pick(r.json), () => null),
    read($, formMapAtom).then(raw => parseOr<FormMapData | null>(raw, null)),
  ])
  const at = bk ? Date.parse(String(bk.createdAt)) : NaN
  gateView = gateLines({
    kind: p.kind,
    appId: p.appId,
    ...(p.name ? { name: p.name, profileName: p.name } : {}),
    ...(ver ? { version: ver } : {}),
    ...(fm && fm.appId === p.appId && fm.appName ? { appName: fm.appName } : {}),
    backupAt: Number.isFinite(at) ? at : null,
    ...(p.plan ? { plan: p.plan } : {}),
  })
  await $.ui.open({ id: GATE, title: gateView.title, focus: true, closeOnEscape: true, holdToasts: true, rows: 9 }).catch(() => undefined)
}
async function closeGate($: EngineInterface) {
  gateView = null
  await $.ui.close({ id: GATE }).catch(() => undefined)
}

async function setPending($: EngineInterface, p: Pending) {
  await update($, confirm, () => JSON.stringify(p))
  await clearNext($)
  void openGate($, p).catch(() => undefined)
  if (p.kind === 'use') {
    await update($, loop, (): RelayLine[] => [
      { text: `確認待ち(本番): 接続先の切り替え`, tone: 'head' },
      { text: pendingHeadline(p), tone: 'head' },
      { text: '切り替える / やめる のボタン、または /kin ok / /kin cancel', tone: 'dim' },
    ])
    await update($, report, () => `mod からの報告: 接続先を本番の ${p.name ?? ''} に切り替える確認待ちです。ユーザーが pane の「切り替える」か /kin ok で進みます。まだ何も変えていません`)
    await openPane($)
    return
  }
  if (p.kind === 'form') {
    const plan = p.plan ?? []
    await update($, loop, (): RelayLine[] => [
      { text: `確認待ち: フォームの変更(アプリ ${p.appId})`, tone: 'head' },
      ...plan.map(text => ({ text: `  ${text}` })),
      { text: '実行 / やめる のボタン、または /kin ok / /kin cancel(欄の削除・ルックアップの解除はしません)', tone: 'dim' },
    ])
    await update($, report, () => `mod からの報告: アプリ ${p.appId} のフォーム変更 ${plan.length} 件は確認待ちです。ユーザーが pane の「実行」か /kin ok で進みます。まだ何も変えていません`)
    await openPane($)
    return
  }
  const what = pendingWhat(p)
  await update($, loop, (): RelayLine[] => [
    { text: `確認待ち(本番): ${what}`, tone: 'head' },
    { text: pendingHeadline(p), tone: 'head' },
    { text: '反映 / やめる のボタン、または /kin ok / /kin cancel', tone: 'dim' },
  ])
  await update($, report, () =>
    `mod からの報告: ${what}(アプリ ${p.appId}・本番)は確認待ちです。ユーザーが pane の「反映」か /kin ok で進みます。まだ何も変えていません`)
  await openPane($)
}

const pendingWhat = (p: Pending) =>
  p.kind === 'use' ? '接続先の切り替え' : p.kind === 'form' ? 'フォームの変更' : p.kind === 'deploy' ? `${p.name} の反映` : p.kind === 'customize' ? 'JS/CSS カスタマイズの反映' : '元に戻す'
const pendingHeadline = (p: Pending) =>
  p.kind === 'use' ? `接続先を ${p.name ?? p.profileId}(本番)に切り替えます` : p.kind === 'form' ? `アプリ ${p.appId} のフォームを変更します(${p.plan?.length ?? p.ops?.length ?? 0} 件)` : p.kind === 'undo' ? `アプリ ${p.appId} を直前の状態に戻します` : `アプリ ${p.appId} に反映します`

async function readPending($: EngineInterface): Promise<Pending | null> {
  const raw = await read($, confirm)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Pending
  } catch {
    return null
  }
}

// 確認(ボタン・/kin ok)。待ちが無ければ null
async function confirmYes($: EngineInterface): Promise<string | null> {
  const p = await readPending($)
  if (!p) return null
  await update($, confirm, () => '')
  await closeGate($)
  if (p.kind === 'use' && p.profileId) {
    const pid = p.profileId
    const name = p.name ?? pid
    await exclusive(() => useNow($, pid, name))
    return `kin: 接続先を ${name} に切り替えました(結果は pane)`
  }
  if (p.kind === 'deploy' && p.dir && p.name) {
    const { dir, name } = p
    await exclusive(() => deployNow($, dir, name, p.appId))
    return `kin: アプリ ${p.appId} に反映しました(結果は pane)`
  }
  if (p.kind === 'form' && p.ops) {
    const ops = p.ops
    await exclusive(() => formChangeNow($, p.appId, ops))
    return `kin: アプリ ${p.appId} のフォームを変更しました(結果は pane)`
  }
  if (p.kind === 'customize' && p.customize) {
    const c = p.customize
    await exclusive(() => customizeNow($, p.appId, c))
    return `kin: アプリ ${p.appId} にカスタマイズを反映しました(結果は pane)`
  }
  await exclusive(() => undoNow($, p.appId))
  return `kin: アプリ ${p.appId} を元に戻す処理をしました(結果は pane)`
}

async function confirmNo($: EngineInterface): Promise<string | null> {
  const p = await readPending($)
  if (!p) return null
  await update($, confirm, () => '')
  await closeGate($)
  if (p.kind === 'use') {
    await update($, loop, (): RelayLine[] => [{ text: 'やめました(接続先は変えていません)', tone: 'dim' }])
    await update($, report, () => 'mod からの報告: 接続先の切り替えはユーザーがやめました。何も変えていません')
    return 'kin: やめました(接続先は変えていません)'
  }
  if (p.kind === 'form') {
    await update($, loop, (): RelayLine[] => [{ text: 'やめました(フォームは変えていません)', tone: 'dim' }])
    await update($, report, () => `mod からの報告: アプリ ${p.appId} のフォーム変更はユーザーがやめました。何も変えていません`)
    return `kin: やめました(アプリ ${p.appId} のフォームは変えていません)`
  }
  await update($, loop, (): RelayLine[] => [{ text: 'やめました(本番には何も反映していません)', tone: 'dim' }])
  await update($, report, () => `mod からの報告: アプリ ${p.appId} への${p.kind === 'undo' ? '巻き戻し' : '反映'}はユーザーがやめました。何も変えていません`)
  return `kin: やめました(アプリ ${p.appId} には何も反映していません)`
}

// ---- 接続先(kin-profile)。保存・切り替えは人だけ(スラッシュコマンドとボタン)。道具にはしない ----

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

async function refreshProfiles($: EngineInterface): Promise<ToolOut> {
  const r = await runToolSafe($, 'kin-profile.mjs', ['list'])
  if (r.json?.ok) {
    const items = ((r.json.items ?? []) as Record<string, unknown>[]).map(it => ({
      id: String(it.id ?? ''),
      name: String(it.name ?? it.id ?? ''),
      host: String(it.host ?? ''),
      kind: isProdKind(it.kind) ? 'prod' : 'dev',
      active: it.active === true,
    }))
    await patchSetup($, v => ({ ...v, profiles: items }))
    const act = items.find(i => i.active)
    if (act) await update($, envMode, () => act.kind)
    await setConn($, act?.name ?? '', act?.kind ?? '')
  }
  return r
}

async function setLoop($: EngineInterface, lines: RelayLine[]) {
  await update($, loop, (): RelayLine[] => lines)
}

async function useNow($: EngineInterface, id: string, name: string) {
  await openPane($)
  await setLoop($, [{ text: `⟳ 接続先を ${name} に切り替え中`, tone: 'head' }])
  const r = await runToolSafe($, 'kin-profile.mjs', ['use', id])
  if (r.json?.ok) {
    await update($, envMode, () => String(r.json?.mode ?? ''))
    await update($, target, () => '')
    await update($, formMapAtom, () => '')
    await setConn($, name, String(r.json?.mode ?? ''))
    await setLoop($, [
      { text: `✓ 接続先を ${name} に切り替えました`, tone: 'ok' },
      { text: `  ホスト: ${redact(String(r.json.host ?? '?'))} ・ モード: ${r.json.mode === 'prod' ? '本番' : '開発'}` },
      { text: '  反映先のアプリは /kin <appId> で選び直してください', tone: 'dim' },
    ])
    await update($, report, () => `mod からの報告: 接続先を ${name}(${r.json?.mode === 'prod' ? '本番' : '開発'})に切り替えました。反映先アプリは未設定です`)
  } else {
    await setLoop($, [{ text: `接続先の切り替え ${name}`, tone: 'head' }, ...formatDeploy(name, r.json, r.raw).slice(1)])
    $.ui.toast(`✗ 切り替えられません ${name}`)
  }
  await refreshProfiles($)
}

// /kin use <id> とボタン「使う」の入口。本番は確認待ちにして止まる。返すのは command の文字
async function useRequest($: EngineInterface, id: string): Promise<string> {
  await openPane($)
  if (!PROFILE_ID.test(id)) return 'kin: 使い方 /kin use <id>(/kin use で一覧)'
  const list = await runToolSafe($, 'kin-profile.mjs', ['list'])
  if (!list.json?.ok) {
    await setLoop($, [{ text: '接続先の一覧', tone: 'head' }, ...formatProfiles(list.json, list.raw)])
    return `kin: 接続先を読めません。${formatProfiles(list.json, list.raw)[1]?.text ?? ''}`
  }
  const item = ((list.json.items ?? []) as Record<string, unknown>[]).find(i => i.id === id || i.name === id)
  if (!item) return `kin: 接続先 ${id} がありません。/kin use で一覧を見てください`
  const pid = String(item.id)
  const name = String(item.name ?? pid)
  if (item.active) return `kin: すでに ${name} を使っています`
  if (isProdKind(item.kind)) {
    await setPending($, { kind: 'use', appId: '', profileId: pid, name })
    return `kin: 接続先を本番の ${name} に切り替えます。pane の「切り替える」か /kin ok で進みます`
  }
  await exclusive(() => useNow($, pid, name))
  return `kin: 接続先を ${name} に切り替えました(結果は pane)`
}

async function openSetup($: EngineInterface) {
  form = blankForm()
  pwSent = false
  await patchSetup($, () => ({ ...EMPTY_SETUP, open: true, rev: (Date.now() % 100000) }))
  await refreshProfiles($)
  // 入力欄にすぐ打てるよう、pane にキーボードを渡す(空のプロンプトの時だけ効く・Esc でプロンプトに戻る)
  await $.ui.open({ id: PANE, title: 'プラグイン作成 mod', focus: true })
}

// 保存。パスワードは form から取り出して即座に空にし、子の標準入力(spawn の input)だけで渡す
async function saveSetup($: EngineInterface) {
  const before = await readSetup($)
  if (before.busy) return
  const f = form
  const apps = parseAppNumbers(f.apps)
  const problems: string[] = []
  const empty: string[] = []
  if (!f.name.trim()) empty.push('名前')
  if (!f.subdomain.trim()) empty.push('サブドメイン')
  if (!f.username.trim()) empty.push('ログイン名')
  if (!f.password && !pwSent) empty.push('パスワード')
  if (f.kind === 'prod' && (apps === null ? !f.apps.trim() : apps.length === 0)) empty.push('本番のアプリ番号')
  if (empty.length) problems.push(`${empty.join('・')}が空です`)
  if (f.subdomain.trim() && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(f.subdomain.trim())) problems.push('サブドメインは英数字と - だけです(例: mycompany)')
  if (apps === null) problems.push('アプリ番号は数字をカンマか空白で区切ってください')
  if (problems.length) {
    await patchSetup($, v => ({ ...v, lines: problems.map(text => ({ text: `✗ ${text}`, tone: 'err' as const })) }))
    return
  }
  const pw = f.password
  form = { ...f, password: '' } // 他の欄は残す。パスワードだけ手放す
  await patchSetup($, v => ({ ...v, busy: true, saved: null, lines: [{ text: '⟳ 保存して確認中…', tone: 'dim' }] }))
  const known = before.profiles.find(p => p.name === f.name.trim() || p.id === f.name.trim())
  const payload = JSON.stringify({
    ...(known ? { id: known.id } : {}),
    name: f.name.trim(),
    subdomain: f.subdomain.trim(),
    domain: f.domain,
    username: f.username.trim(),
    ...(pw ? { password: pw } : {}),
    kind: f.kind,
    apps: apps ?? [],
  })
  const r = await runToolSafe($, 'kin-profile.mjs', ['save'], payload)
  const ok = r.json?.ok === true
  const saved = ok ? { id: String(r.json?.id ?? ''), active: r.json?.active === true } : null
  const lines = formatSaveResult(r.json, r.raw, pw)
  if (saved) {
    if (pw) pwSent = true
    lines.unshift({ text: saved.active ? '✓ 保存しました(いまの接続先です)' : `✓ 保存しました → /kin use ${saved.id} で切り替え`, tone: 'ok' })
    await update($, report, () => `mod からの報告: 接続設定を保存しました(接続先 id: ${saved.id})。${saved.active ? 'いまの接続先です' : `切り替えは /kin use ${saved.id}`}`)
  }
  await patchSetup($, v => ({ ...v, busy: false, lines, saved }))
  if (!ok) form.password = pw // 失敗なら打ち直さずに再保存できるよう戻す(表示はしない)
  if (ok) {
    const st = (r.json?.check?.status ?? {}) as Record<string, unknown>
    if (saved?.active && (st.mode === 'dev' || st.mode === 'prod')) await update($, envMode, () => String(st.mode))
    $.ui.toast('設定済み')
  } else {
    $.ui.toast('✗ 接続設定を保存できません')
  }
  await refreshProfiles($)
}

async function undoNow($: EngineInterface, appId: string) {
  await openPane($)
  await update($, loop, (): RelayLine[] => [{ text: `⟳ 元に戻し中 アプリ ${appId}`, tone: 'head' }])
  const r = await runToolSafe($, 'kin-loop.mjs', ['undo', appId])
  await update($, loop, () => formatUndo(r.json, r.raw))
  await update($, report, () => reportFromUndo(r.json, r.raw))
  await pushDigest($, 'undo', digestUndo(r.json, r.raw))
  if (!r.json?.ok) $.ui.toast(`✗ 元に戻せません アプリ ${appId}`)
}

type DeployOut = { dep: ToolOut; probe?: ToolOut; probes?: { appId: string; out: ToolOut }[]; next?: string }

// fromTool: モデルが道具で呼んだ反映。結果は道具の返り値で返すので、次のプロンプトへの報告・digest は積まない(pane は同じに更新)
// 道具の相対パスはセッション開始時の作業フォルダで解く(Bash の cd で $.session.cwd がずれるため)
let startCwd: string | undefined
async function projectCwd($: EngineInterface): Promise<string> {
  return startCwd ?? (await $.session.cwd())
}

// v1.0 画面チェックの結果から pane の材料(イベントを種類ごとに足す・読み込み回数・縮小のパス)。url は pane の Link にだけ使う
function probeView(j: Record<string, any> | null): Pick<Pulse, 'events' | 'loads' | 'shots' | 'shotNote'> {
  const pages = (Array.isArray(j?.pages) ? j!.pages : []) as Record<string, any>[]
  const by = new Map<string, EventRow>()
  let loads = 0
  for (const pg of pages) {
    loads += Number(pg.loads) || 0
    for (const ev of (Array.isArray(pg.events) ? pg.events : []) as Record<string, any>[]) {
      const t = String(ev.type ?? '')
      if (!t) continue
      const cur = by.get(t) ?? { type: t, count: 0, handlers: 0 }
      by.set(t, { type: t, count: cur.count + (Number(ev.count) || 0), handlers: Math.max(cur.handlers, Number(ev.handlers) || 0) })
    }
  }
  const urlOf = (page: string) => pages.find(pg => pg.name === page && typeof pg.url === 'string')?.url as string | undefined
  const shots = ((Array.isArray(j?.thumbs) ? j!.thumbs : []) as Record<string, any>[])
    .filter(t => typeof t.path === 'string' && ['index', 'detail', 'config'].includes(String(t.page)))
    .slice(0, 3)
    .map(t => ({ page: t.page as ScreenPage, path: String(t.path), width: Number(t.width) || 540, height: Number(t.height) || 338, ...(urlOf(t.page) ? { url: urlOf(t.page) } : {}) }))
  return {
    events: [...by.values()],
    loads,
    shots,
    ...(typeof j?.thumbsError === 'string' ? { shotNote: redact(j.thumbsError).split('\n')[0]!.slice(0, 120) } : {}),
  }
}

// v1.0 反映の直後 60 秒は帯に [戻す]。60 秒たったら消す(その間に別のアプリへ反映していたら触らない)
async function offerUndo($: EngineInterface, appId: string) {
  await update($, undoOfferAtom, () => appId)
  $.clock.after(60_000, async () => {
    if ((await read($, undoOfferAtom)) === appId) await update($, undoOfferAtom, () => '')
  })
}

async function deployNow($: EngineInterface, dir: string, name: string, appId: string, fromTool = false): Promise<DeployOut> {
  if (fromTool) toolDeployedAt.set(name, Date.now())
  await clearNext($)
  await openPane($)
  await update($, loop, (): RelayLine[] => [{ text: `⟳ 反映中 ${name} → アプリ ${appId}`, tone: 'head' }])
  // 鼓動は直近1回分だけ(前の結果欄も消える)
  await update($, pulseAtom, () => JSON.stringify(initPulse(name, appId, Date.now())))
  try {
    const out = await deploySteps($, dir, name, appId, fromTool)
    // ビルド・反映で止まった時も、終わった時刻と合計を入れる(帯の「最後の反映」)
    const now = Date.now()
    await patchPulse($, p => (p.finishedAt ? p : { ...p, finishedAt: now, totalSeconds: Math.round((now - p.startedAt) / 100) / 10 }))
    return out
  } catch (err) {
    await patchPulse($, p => failPulse(p, Date.now(), redact(err instanceof Error ? err.message : String(err))))
    throw err
  }
}

async function deploySteps($: EngineInterface, dir: string, name: string, appId: string, fromTool: boolean): Promise<DeployOut> {

  // 設定値 API(item 6): kin-loop は --config <json> を持つので、relay.config.json があれば渡す
  const configFile = `${dir}/relay.config.json`
  let hasConfig = false
  try {
    await $.fs.read(configFile)
    hasConfig = true
  } catch {
    hasConfig = false
  }

  // ビルド段(kin-build): relay.config.json に build があれば command を先に走らせ、出来た dir を包む。失敗したら反映しない
  const bld = await runToolSafe($, 'kin-build.mjs', [dir])
  await patchPulse($, p => applyBuild(p, bld.json as Parameters<typeof applyBuild>[1]))
  if (!bld.json?.ok) {
    const failJson = buildFailure(bld.json, bld.raw)
    const failed: ToolOut = { json: failJson as ToolOut['json'], raw: bld.raw.timedOut ? bld.raw : { ...bld.raw, stderr: '' } }
    await update($, loop, (): RelayLine[] => [{ text: `✗ ビルド失敗 ${name}(反映していません)`, tone: 'err' }, ...formatDeploy(name, failJson, failed.raw).slice(1)])
    if (!fromTool) await update($, report, () => reportFromDeployFailure(name, failJson, failed.raw))
    $.ui.toast(`✗ ビルド失敗 ${name}`)
    return { dep: failed }
  }
  const builtDir = typeof bld.json.dir === 'string' && bld.json.dir ? bld.json.dir : dir
  const buildLine: RelayLine[] = bld.json.built ? [{ text: `✓ ビルド${bld.json.seconds !== undefined ? ` ${bld.json.seconds} 秒` : ''} → ${builtDir}`, tone: 'dim' }] : []
  // relay.config.json は元のプラグイン(src)のものを渡す(ビルドの出力側ではない)
  const deployArgs = ['deploy', builtDir, appId, ...(hasConfig ? ['--config', configFile] : [])]

  const dep = await runToolSafe($, 'kin-loop.mjs', deployArgs)
  await patchPulse($, p => applyDeploy(p, dep.json as Record<string, any> | null))
  // 道具の結果にもビルドの段を出す(包んだのが出力側か分かるように)
  if (dep.json && bld.json.built) (dep.json as Record<string, unknown>).build = { dir: builtDir, seconds: bld.json.seconds }
  const depLines = [...formatDeploy(name, dep.json, dep.raw), ...buildLine]
  const configLine: RelayLine[] = hasConfig
    ? []
    : [{ text: '設定は画面で(plugins/<name>/relay.config.json があれば設定値 API で入れます)', tone: 'dim' }]

  if (!dep.json?.ok) {
    await update($, loop, (): RelayLine[] => [...depLines, ...configLine])
    if (!fromTool) await update($, report, () => reportFromDeployFailure(name, dep.json, dep.raw))
    $.ui.toast(`✗ 反映失敗 ${name}`)
    return { dep }
  }

  await update($, loop, (): RelayLine[] => [...depLines, ...configLine, { text: '⟳ 画面チェック中…', tone: 'dim' }])
  // 複数アプリ("65,53"): 画面チェックは各アプリで
  const ids = appId.split(',')
  const probes: { appId: string; out: ToolOut }[] = []
  let probeLines: RelayLine[] = []
  // v1.0 反映ごと1回・3画面までの縮小(pane の「画面」。モデルには見せない)。最初のアプリだけ
  const thumbDir = `${(await $.env.get('TMPDIR').catch(() => undefined)) || '/tmp'}/relay-thumbs-${Date.now()}`
  for (const id of ids) {
    const out = await runToolSafe($, 'kin-probe.mjs', [id, ...(dep.json.pluginId ? ['--plugin', String(dep.json.pluginId)] : []), ...(id === ids[0] ? ['--thumbs', thumbDir] : [])])
    probes.push({ appId: id, out })
    const lines = formatProbe(out.json, out.raw)
    probeLines = [...probeLines, ...(ids.length > 1 ? [{ text: `アプリ ${id}`, tone: 'head' as const }] : []), ...lines]
    await update($, loop, (): RelayLine[] => [...depLines, ...configLine, ...probeLines, ...(id === ids[ids.length - 1] ? [] : [{ text: '⟳ 画面チェック中…', tone: 'dim' as const }])])
    if (!fromTool) await pushDigest($, 'probe', digestProbe(id, out.json, out.raw))
  }
  const probe = probes[0]!.out
  // 鼓動: 画面チェックの段とエラー(プラグインの行が分かる物は前後3行)
  const manifestJs = await $.fs.read(`${builtDir}/manifest.json`).then(t => {
    const m = JSON.parse(t)
    return [...(m?.desktop?.js ?? []), ...(m?.mobile?.js ?? [])].filter((x: unknown): x is string => typeof x === 'string')
  }, () => [] as string[])
  const probed = applyProbe((await readPulse($)) ?? initPulse(name, appId, Date.now()), probes.map(x => ({ appId: x.appId, json: x.out.json as Record<string, any> | null })), Date.now())
  const errors = await attachSnippets(probed.errors, manifestJs, rel => $.fs.read(`${builtDir}/${rel}`).then(t => t, () => null))
  await update($, pulseAtom, () => JSON.stringify({ ...probed, errors, ...probeView(probe.json) }))
  if (probe.json && dep.json.ok) await offerUndo($, ids[0] ?? appId)

  const summary = reportFromProbe(probe.json)
  const line =
    summary ??
    redact(
      `mod からの報告: ${name} は反映済み(${dep.json.seconds}秒)・画面チェック不可: ${String(
        probe.json?.error?.message ?? probe.raw.stderr ?? '',
      ).split('\n')[0]}`,
    ).slice(0, 300)
  if (!fromTool) await update($, report, () => line)
  if (probe.json && probe.json.ok === false) $.ui.toast(`画面にエラーあり ${name}`)
  const next = await offerNext($, builtDir, name, ids[0] ?? appId, dep.json)
  return { dep, probe, probes, next }
}

// ---- 反映の後の「次の一手」。pane のボタン・次のプロンプトの context・道具の結果に同じ一覧を出す ----
// v0.9: 結果はログ行に流さない(デスクトップ版では見えない)。ログ行は端末だけのセッションでの一覧の控えだけ。1行ずつ(改行は画面で化ける)
async function logLines($: EngineInterface, text: string) {
  const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
  if (surfaces.some(s => s !== 'terminal')) return
  for (const l of text.split('\n')) if (l.trim()) $.ui.log(l)
}
async function offerNext($: EngineInterface, dir: string, name: string, appId: string, dep: NonNullable<ToolOut['json']>): Promise<string> {
  const pluginId = typeof dep.pluginId === 'string' ? dep.pluginId : ''
  const mode = (await read($, envMode)) === 'prod' ? 'prod' : 'dev'
  // レコードが1件でもあれば詳細 URL に使う(読むだけ・失敗しても一覧は出す)
  const recs = await runToolSafe($, 'kin-loop.mjs', ['records', appId, '--limit', '1', '--fields', '$id'])
  const first = recs.json?.ok && Array.isArray(recs.json.records) ? (recs.json.records[0] as Record<string, any> | undefined) : undefined
  const rid = String(first?.$id?.value ?? first?.$id ?? '')
  const tr = await runToolSafe($, 'kin-records.mjs', ['list', appId])
  const testRecords = tr.json?.ok ? Math.max(0, Math.floor(Number(tr.json.count) || 0)) : 0
  const s: NextState = {
    appId,
    name,
    dir,
    pluginId,
    origin: typeof dep.origin === 'string' ? dep.origin : '',
    mode,
    shot: sheetSeen.has(`${appId}:${pluginId}`),
    ...(/^\d+$/.test(rid) ? { rec: rid } : {}),
    ...(testRecords > 0 ? { testRecords } : {}),
  }
  await update($, nextAtom, () => JSON.stringify(s))
  await logLines($, logNextList(s))
  await pushDigest($, 'next', mdNextForModel(s))
  return mdNextForModel(s)
}

// 番号の処理。command(/kin next <n>)・pane のボタン・素の番号の入力の三つが同じものを通る。返すのは会話に出す文字
async function runNext($: EngineInterface, n: number): Promise<string> {
  const s = await readNext($)
  if (!s) return 'kin: 次の一手は出ていません(反映の後に出ます)'
  if (!nextItems(s).some(i => i.n === n && i.on)) return `kin: ${n} は今は選べません。${mdNextList(s)}`
  switch (n) {
    case 1:
      return mdNextUrls(s)
    case 2:
      return mdNextConfig(s)
    case 3: {
      sheetSeen.add(`${s.appId}:${s.pluginId}`)
      await update($, nextAtom, () => JSON.stringify({ ...s, shot: true }))
      const tdir = (await $.env.get('TMPDIR').catch(() => undefined)) || '/tmp'
      const out = `${tdir}/relay-sheet-${s.appId}-${Date.now()}.png`
      await openPane($)
      const r = await runToolSafe($, 'kin-probe.mjs', [s.appId, ...(s.pluginId ? ['--plugin', s.pluginId] : []), '--pages', 'config,index', '--sheet', out])
      const sheet = typeof r.json?.sheet === 'string' ? r.json.sheet : null
      return mdNextShot(sheet, redact(String(r.json?.sheetError ?? r.json?.error?.message ?? r.raw.stderr ?? '')).split('\n')[0] ?? '')
    }
    case 4:
      await clearNext($)
      return NEXT_CREATE
    case 5: {
      return undoRequest($, s.appId)
    }
    case 6: {
      const r = await runToolSafe($, 'kin-profile.mjs', ['list'])
      if (!r.json?.ok) return `6 本番に入れる\n接続先を読めません。${SETUP_NEEDED}`
      const items = ((r.json.items ?? []) as Record<string, unknown>[]).map(it => ({ id: String(it.id ?? ''), name: String(it.name ?? it.id ?? ''), host: String(it.host ?? ''), kind: String(it.kind ?? '') }))
      return mdNextProd(items, s.appId)
    }
    case 8: {
      // 試験データの片付け(開発だけ)。記録した id だけを消す
      const g = await recordsGate($, s.appId)
      if (!g.go) return `8 試験データを片付ける\n${JSON.parse(g.text)?.error?.message ?? '片付けられません'}`
      const r = await runToolSafe($, 'kin-records.mjs', ['cleanup', s.appId])
      await refreshTestCount($, s.appId)
      return mdNextCleanup(r.json, r.raw)
    }
    default: {
      const r = await runToolSafe($, 'kin-loop.mjs', ['pack', s.dir])
      await clearNext($)
      return mdNextPack(r.json)
    }
  }
}

// 番号の結果を pane の結果欄にも置く。/kin next・素の番号・pane のボタンの三つがここを通る
// (mod 自身の $.command.run は自分の command.run に届かないので、/kin next を走らせ直す形は取れない。10/24 本物で確認)
async function runNextShown($: EngineInterface, n: number): Promise<string> {
  const t = redact(await runNext($, n))
  await setResult($, `次の一手 ${n}`, t)
  return t
}
// pane のボタン: 結果は pane の結果欄へ。端末だけのセッションでは会話のログ行にも
function pressNext($: EngineInterface, n: number) {
  void runNextShown($, n).then(t => logLines($, t)).catch(err => $.ui.log(`plugbits-relay: 次の一手 ${n} が失敗しました ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' }))
}
const onlyTerminal = async ($: EngineInterface) => !(await $.session.surfaces().catch(() => [] as readonly string[])).some(s => s !== 'terminal')

// 戻す(/kin undo と次の一手 5 が共有)。開発は即時・本番は確認待ち。返すのは command の文字
async function undoRequest($: EngineInterface, appId: string): Promise<string> {
  await clearNext($)
  const m = await checkMode($, appId)
  if (m.kind === 'denied') {
    await showDenied($, `アプリ ${appId} を元に戻す`, m.out)
    return `kin: 止めました。${redact(String(m.out.json?.error?.message ?? m.out.raw.stderr ?? '')).split('\n')[0]}`
  }
  if (m.kind === 'prod') {
    await setPending($, { kind: 'undo', appId })
    return `kin: アプリ ${appId} を直前の状態に戻します(本番)。pane の「反映」か /kin ok で進みます`
  }
  await exclusive(() => undoNow($, appId))
  return `kin: アプリ ${appId} を元に戻す処理をしました(結果は pane)`
}

async function pump($: EngineInterface) {
  try {
    await $.clock.sleep(DEBOUNCE_MS)
    while (pending.size > 0) {
      const dir = pending.values().next().value as string
      pending.delete(dir)
      const hit = pluginOf(`${dir}/x`)
      if (!hit) continue
      // 道具(kin_deploy)が直前に同じプラグインを反映したなら、保存の自動反映は重ねない
      if (isRecentToolDeploy(hit.name)) continue
      // 他のプラグインの build.dir(ビルドの出力)への保存は、それ自身の自動反映を起こさない(元の src の保存が反映する)
      if (await isBuildOutput($, hit)) continue
      try {
        await runOne($, hit.dir, hit.name)
      } catch (e) {
        await update($, loop, (): RelayLine[] => [{ text: `✗ ${redact(e instanceof Error ? e.message : String(e))}`, tone: 'err' }])
      }
    }
  } finally {
    isPumping = false
  }
}

// plugins/<name>/ が、同じ plugins/ の他のプラグインの relay.config.json の build.dir(出力先)か。読めなければ false
async function isBuildOutput($: EngineInterface, hit: { dir: string; name: string }): Promise<boolean> {
  const parent = hit.dir.replace(/\/[^/]+$/, '')
  try {
    for (const en of await $.fs.list(parent)) {
      if (en.name === hit.name || en.kind === 'file') continue
      let cfg: any
      try {
        cfg = JSON.parse(await $.fs.read(`${parent}/${en.name}/relay.config.json`))
      } catch {
        continue
      }
      const d = typeof cfg?.build?.dir === 'string' ? cfg.build.dir.replace(/^\.\//, '').replace(/\/+$/, '') : ''
      if (d === `plugins/${hit.name}`) return true
    }
  } catch {
    /* 一覧が読めなければ普通の保存として扱う */
  }
  return false
}

function schedule($: EngineInterface, dir: string) {
  pending.add(dir)
  if (!isPumping) {
    isPumping = true
    void pump($)
  }
}


function schedulePlugin($: EngineInterface, filePath: string): void {
  const hit = pluginOf(filePath)
  if (hit) schedule($, hit.dir)
}


// ---- モデルが呼べる道具(kin_*)。$.tool.register で宣言し、tool.call で答える ----
// 道具の引数は appId / pluginDir / ファイルパスだけ。接続先・認証は env だけ(tools 側)。
// 本番への書き込みは「確認待ち」を返して止まる。確認する道(confirmYes)は /kin ok とボタンだけ。
const TOOL_PREFIX = 'mcp__plugbits-relay__'
const appIdSchema = { type: 'string', description: 'kintone のアプリ番号 / app id (例 "42")' }
const LOOP = 'typical loop: kin_form → kin_scaffold → edit files → kin_deploy → kin_probe (actions to operate the screen) → fix → kin_undo if needed. Test data: kin_records_write → kin_records_cleanup. Form changes (dev only): kin_form_change.'

type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const awaiting = (appId: string) =>
  safeJson({
    status: 'awaiting_human_confirmation',
    message: `本番のアプリ ${appId} への反映は人の確認待ちです。画面のボタンか /kin ok で通ります`,
  })

const str = (v: unknown) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])
const need = (appId: string) => (isAppId(appId) ? null : safeJson({ ok: false, error: { code: 'bad_input', message: 'appId は数字のアプリ番号です' } }))
const rejected = (what: string) =>
  safeJson({ ok: false, error: { code: 'path_rejected', message: `${what} は許可された場所の外です(プラグインはセッションの plugins/ 配下・ファイルは作業フォルダ配下だけ)` } })

async function readTool($: EngineInterface, script: string, args: string[], fmt: (j: NonNullable<ToolOut['json']>) => string) {
  const r = await runToolSafe($, script, args)
  return r.json?.ok ? fmt(r.json) : toolError(r.json, r.raw)
}

// 書く系の前段: 'dev' なら続行、'prod' は確認待ちにして文言を返す、拒否・不明は止める(fail closed)
async function gateWrite($: EngineInterface, appId: string, p: Pending): Promise<{ go: true } | { go: false; text: string }> {
  const m = await checkMode($, appId)
  if (m.kind === 'denied') {
    await openPane($)
    await showDenied($, `アプリ ${appId} への書き込み(${pendingWhat(p)})`, m.out)
    return { go: false, text: toolError(m.out.json, m.out.raw) }
  }
  if (m.kind === 'prod') {
    await setPending($, p)
    return { go: false, text: awaiting(appId) }
  }
  return { go: true }
}

async function customizeNow($: EngineInterface, appId: string, c: CustomizeArgs): Promise<ToolOut> {
  await openPane($)
  await update($, loop, (): RelayLine[] => [{ text: `⟳ カスタマイズ反映中 → アプリ ${appId}`, tone: 'head' }])
  const args = ['customize', appId]
  if (c.js.length) args.push('--js', c.js.join(','))
  if (c.css.length) args.push('--css', c.css.join(','))
  if (c.mobileJs.length) args.push('--mobile-js', c.mobileJs.join(','))
  if (c.mobileCss.length) args.push('--mobile-css', c.mobileCss.join(','))
  const r = await runToolSafe($, 'kin-loop.mjs', args)
  await update($, loop, () => formatDeploy('カスタマイズ', r.json, r.raw))
  if (!r.json?.ok) $.ui.toast(`✗ カスタマイズ反映失敗 アプリ ${appId}`)
  return r
}

// kind ごとの形(tools/kin-scaffold.mjs の KINDS と同じ並び)
const SCAFFOLD_KINDS = ['event', 'config-only', 'header-button', 'index-band', 'detail-notice']

async function scaffoldTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const name = str(input.name)
  const kind = str(input.kind)
  const appId = str(input.appId)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return safeJson({ ok: false, error: { code: 'bad_input', message: 'name は英数字と - _ だけ(64字まで)' } })
  if (!SCAFFOLD_KINDS.includes(kind)) return safeJson({ ok: false, error: { code: 'bad_input', message: `kind は ${SCAFFOLD_KINDS.join(' / ')}` } })
  if (appId && need(appId)) return need(appId)!
  const cwd = await projectCwd($)
  const args = [name, kind, '--root', cwd]
  let tmp: string | undefined
  if (appId) {
    // フォームのフィールドを一時ファイルで渡す($.fs で書く。終わったら消す)
    const form = await runToolSafe($, 'kin-loop.mjs', ['form', appId])
    if (!form.json?.ok) return toolError(form.json, form.raw)
    const tdir = (await $.env.get('TMPDIR').catch(() => undefined)) || '/tmp'
    tmp = `${tdir}/relay-fields-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`
    await $.fs.write(tmp, JSON.stringify({ fields: form.json.fields ?? [] }))
    args.push('--app', appId, '--fields-json', tmp)
  }
  try {
    const r = await runToolSafe($, 'kin-scaffold.mjs', args)
    return r.json?.ok ? safeJson({ ok: true, dir: r.json.dir, files: r.json.files }) : toolError(r.json, r.raw)
  } finally {
    if (tmp) await collect($, ['rm', '-f', tmp]).catch(() => undefined)
  }
}

async function deployTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  // appId は "65" か "65,53"(カンマ区切り)。appIds の配列でも可。複数は開発だけ
  const ids = [...new Set((Array.isArray(input.appIds) && input.appIds.length ? strList(input.appIds) : str(input.appId).split(/[\s,、]+/)).filter(Boolean))]
  if (ids.length === 0) return need('')!
  for (const id of ids) if (need(id)) return need(id)!
  if (ids.length > 10) return safeJson({ ok: false, error: { code: 'bad_input', message: 'アプリは10個までです' } })
  const appId = ids.join(',')
  const cwd = await projectCwd($)
  const dir = resolveUnder(cwd, str(input.pluginDir), 'plugins')
  if (!dir) return rejected('pluginDir')
  const name = dir.slice(dir.indexOf('/plugins/') + '/plugins/'.length).split('/')[0] ?? dir
  const pluginDir = `${cwd.replace(/\/+$/, '')}/plugins/${name}`
  if (ids.length > 1) {
    // 複数アプリは開発だけ(本番は確認を1アプリずつ人が通す)。ひとつでも本番・拒否なら全部止める
    for (const id of ids) {
      const m = await checkMode($, id)
      if (m.kind === 'denied') return toolError(m.out.json, m.out.raw)
      if (m.kind === 'prod') return safeJson({ ok: false, error: { code: 'prod_denied', message: `アプリ ${id} は本番です。本番は1アプリずつ(appId を1つにして呼んでください)` } })
    }
  }
  // 保存の自動反映が待っていたら捨てる(この呼び出しが代わりに反映する)
  for (const d of [...pending]) if (pluginOf(`${d}/x`)?.name === name) pending.delete(d)
  toolDeployedAt.set(name, Date.now())
  if (ids.length === 1) {
    const gate = await gateWrite($, appId, { kind: 'deploy', appId, dir: pluginDir, name })
    if (!gate.go) return gate.text
  }
  const out = await exclusive(() => deployNow($, pluginDir, name, appId, true))
  if (ids.length > 1) {
    if (!out.dep.json?.ok && !out.dep.json?.apps) return toolError(out.dep.json, out.dep.raw)
    const dj = out.dep.json!
    return mdDeployMulti(name, dj, (out.probes ?? []).map(p => ({ appId: p.appId, md: digestProbe(p.appId, p.out.json, p.out.raw) }))) + (out.next ? `\n\n${out.next}` : '')
  }
  if (!out.dep.json?.ok) return toolError(out.dep.json, out.dep.raw)
  const probeMd = out.probe ? digestProbe(appId, out.probe.json, out.probe.raw) : null
  return mdDeployResult(name, appId, out.dep.json, probeMd) + (out.next ? `\n\n${out.next}` : '')
}

async function undoTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const appId = str(input.appId)
  if (need(appId)) return need(appId)!
  const gate = await gateWrite($, appId, { kind: 'undo', appId })
  if (!gate.go) return gate.text
  const r = await exclusive(() => undoNowTool($, appId))
  return r.json?.parts ? digestUndo(r.json, r.raw) : toolError(r.json, r.raw)
}

// undoNow と同じ pane 更新をして、結果も返す(次のプロンプトへの報告は積まない)
async function undoNowTool($: EngineInterface, appId: string): Promise<ToolOut> {
  await openPane($)
  await update($, loop, (): RelayLine[] => [{ text: `⟳ 元に戻し中 アプリ ${appId}`, tone: 'head' }])
  const r = await runToolSafe($, 'kin-loop.mjs', ['undo', appId])
  await update($, loop, () => formatUndo(r.json, r.raw))
  if (!r.json?.ok) $.ui.toast(`✗ 元に戻せません アプリ ${appId}`)
  return r
}

async function customizeTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const appId = str(input.appId)
  if (need(appId)) return need(appId)!
  const cwd = await projectCwd($)
  const keys = ['js', 'css', 'mobileJs', 'mobileCss'] as const
  const c: CustomizeArgs = { js: [], css: [], mobileJs: [], mobileCss: [] }
  for (const k of keys) {
    for (const f of strList(input[k])) {
      const abs = resolveUnder(cwd, f)
      if (!abs) return rejected(f)
      c[k].push(abs)
    }
  }
  if (keys.every(k => c[k].length === 0)) return safeJson({ ok: false, error: { code: 'bad_input', message: 'js / css のどれかにファイルを指定してください' } })
  const gate = await gateWrite($, appId, { kind: 'customize', appId, customize: c })
  if (!gate.go) return gate.text
  const r = await exclusive(() => customizeNow($, appId, c))
  return r.json?.ok ? safeJson(r.json) : toolError(r.json, r.raw)
}


async function statusTool($: EngineInterface): Promise<string> {
  const r = await runToolSafe($, 'kin-loop.mjs', ['status'])
  if (!r.json?.ok) return toolError(r.json, r.raw)
  // どの接続先か(名前)。取れなくても status は返す
  const p = await runToolSafe($, 'kin-profile.mjs', ['status'])
  const name = p.json?.ok && typeof p.json.name === 'string' ? p.json.name : undefined
  return pickStatus(r.json, name)
}
async function appsTool($: EngineInterface): Promise<string> {
  return readTool($, 'kin-loop.mjs', ['apps'], j => safeJson({ ok: true, apps: j.apps ?? [] }))
}
async function formTool($: EngineInterface, i: Record<string, unknown>): Promise<string> {
  const appId = str(i.appId)
  if (need(appId)) return need(appId)!
  return readTool($, 'kin-loop.mjs', ['form', appId], j => safeJson({ ok: true, appId, fields: j.fields ?? [], views: j.views ?? [] }))
}
async function pluginsTool($: EngineInterface, i: Record<string, unknown>): Promise<string> {
  const appId = str(i.appId)
  if (need(appId)) return need(appId)!
  return readTool($, 'kin-loop.mjs', ['plugins', appId], j => mdPlugins(appId, j))
}
async function recordsTool($: EngineInterface, i: Record<string, unknown>): Promise<string> {
  const appId = str(i.appId)
  if (need(appId)) return need(appId)!
  const limit = Math.min(20, Math.max(1, Math.floor(Number(i.limit) || 10)))
  const args = ['records', appId, '--limit', String(limit)]
  const q = str(i.query)
  if (q) args.push('--query', q)
  const fields = strList(i.fields).filter(f => !/[,\n]/.test(f))
  if (fields.length) args.push('--fields', fields.join(','))
  return readTool($, 'kin-loop.mjs', args, j => safeJson({ ok: true, totalCount: j.totalCount, records: j.records ?? [] }).slice(0, 30000))
}
// 縮小1枚を見たプラグイン(アプリ×pluginId)。「次の一手」の 3 を出すかどうかだけに使う。kin_probe の依頼は毎回作れる
const sheetSeen = new Set<string>()

const prodDenied = (what: string) => safeJson({ ok: false, error: { code: 'prod_denied', message: `本番では${what}できません(開発環境だけ)` } })

// 開発の時だけ続行。本番は拒否(確認待ちにしない)、拒否・不明は止める(fail closed)
async function recordsGate($: EngineInterface, appId: string, what = '試験データの書き込み・片付けは'): Promise<{ go: true } | { go: false; text: string }> {
  const m = await checkMode($, appId)
  if (m.kind === 'denied') return { go: false, text: toolError(m.out.json, m.out.raw) }
  if (m.kind === 'prod') return { go: false, text: prodDenied(what.replace(/は$/, '')) }
  return { go: true }
}

// 一時ファイルに JSON を書く($.fs)。使い終わったら rmTmp
async function writeTmp($: EngineInterface, prefix: string, data: unknown): Promise<string> {
  const tdir = (await $.env.get('TMPDIR').catch(() => undefined)) || '/tmp'
  const tmp = `${tdir}/relay-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`
  await $.fs.write(tmp, JSON.stringify(data))
  return tmp
}
const rmTmp = ($: EngineInterface, tmp: string | undefined) => (tmp ? collect($, ['rm', '-f', tmp]).then(() => undefined, () => undefined) : Promise.resolve())

// 試験データの件数を「次の一手」(8)に反映する
async function refreshTestCount($: EngineInterface, appId: string) {
  const r = await runToolSafe($, 'kin-records.mjs', ['list', appId])
  const ns = await readNext($)
  if (!ns || ns.appId !== appId) return
  const count = r.json?.ok ? Math.max(0, Math.floor(Number(r.json.count) || 0)) : 0
  const { testRecords: _drop, ...rest } = ns
  await update($, nextAtom, () => JSON.stringify(count > 0 ? { ...rest, testRecords: count } : rest))
}

const PROBE_ACTION_KINDS = ['open', 'click', 'fill', 'select', 'press', 'save', 'expect', 'wait', 'read']
const PROBE_WRITE_KINDS = ['fill', 'select', 'press', 'save', 'click']
const OPEN_PAGES = ['detail', 'index', 'config', 'create', 'edit']

// 手順の形を軽く確かめる(中身の細かい検査は kin-probe)。bad ならメッセージ
function checkActions(v: unknown): { ok: true; actions: Record<string, unknown>[] } | { ok: false; message: string } {
  if (!Array.isArray(v) || v.length === 0 || v.length > 30) return { ok: false, message: 'actions は 1〜30 個の手順の配列' }
  const out: Record<string, unknown>[] = []
  for (const [k, a] of v.entries()) {
    const keys = a && typeof a === 'object' && !Array.isArray(a) ? Object.keys(a as object).filter(x => PROBE_ACTION_KINDS.includes(x)) : []
    if (keys.length !== 1) return { ok: false, message: `手順 ${k + 1}: ${PROBE_ACTION_KINDS.join(' / ')} のどれか1つだけを持つオブジェクト` }
    const kind = keys[0]!
    const val = (a as Record<string, unknown>)[kind]
    const obj = val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null
    const bad = (m: string) => ({ ok: false as const, message: `手順 ${k + 1} (${kind}): ${m}` })
    if (kind === 'open' && !(typeof val === 'string' && OPEN_PAGES.includes(val))) return bad(`open は ${OPEN_PAGES.join(' / ')}`)
    if (kind === 'click' && !(typeof val === 'string' || (obj && typeof obj.name === 'string'))) return bad("click は 'text=…' か {role, name}")
    const hasValue = !!obj && (typeof obj.value === 'string' || typeof obj.value === 'number')
    if (kind === 'fill' && !(hasValue && typeof obj!.label === 'string')) return bad('{label, value} が要ります')
    // select はラベルの無い選択欄なら value(選択肢の文字)だけでよい
    if (kind === 'select' && !(hasValue && (obj!.label === undefined || typeof obj!.label === 'string'))) return bad('{label?, value} が要ります')
    if (kind === 'press' && typeof val !== 'string') return bad("press は 'Enter' のようなキー名")
    if (kind === 'expect' && !(obj && typeof obj.text === 'string')) return bad('{text} が要ります')
    if (kind === 'wait' && !(typeof val === 'number' && val >= 0)) return bad('wait はミリ秒の数')
    out.push(a as Record<string, unknown>)
  }
  return { ok: true, actions: out }
}

async function probeTool($: EngineInterface, i: Record<string, unknown>): Promise<string> {
  const appId = str(i.appId)
  if (need(appId)) return need(appId)!
  const pages = strList(i.pages)
  if (pages.some(p => !['config', 'detail', 'index'].includes(p))) return safeJson({ ok: false, error: { code: 'bad_input', message: 'pages は config / detail / index' } })
  const pluginId = str(i.pluginId)
  if (pluginId && !/^[a-z]{32}$/.test(pluginId)) return safeJson({ ok: false, error: { code: 'bad_input', message: 'pluginId は英小文字 32 字' } })
  let actions: Record<string, unknown>[] | undefined
  if (i.actions !== undefined) {
    const c = checkActions(i.actions)
    if (!c.ok) return safeJson({ ok: false, error: { code: 'bad_input', message: c.message } })
    actions = c.actions
    // 書き込みになる手順(入力・保存・クリック・キー)は開発だけ。本番は確認待ちにせず拒否
    if (actions.some(a => PROBE_WRITE_KINDS.some(k => k in a))) {
      const g = await recordsGate($, appId, '画面の操作(入力・選択・クリック・キー・保存)は')
      if (!g.go) return g.text
    }
  }
  const args = [appId, ...(pluginId ? ['--plugin', pluginId] : []), ...(!actions && pages.length ? ['--pages', pages.join(',')] : [])]
  let tmp: string | undefined
  let sheetAsked = false
  try {
    if (actions) {
      tmp = await writeTmp($, 'actions', actions)
      args.push('--actions', tmp)
    }
    if (i.screenshots === true) {
      sheetAsked = true
      // 縮小1枚は 1 回の kin_probe 呼び出しにつき最大1枚。次の一手の 3 は「見た」扱いにする
      sheetSeen.add(`${appId}:${pluginId}`)
      const ns = await readNext($)
      if (ns && ns.appId === appId && (!pluginId || ns.pluginId === pluginId)) await update($, nextAtom, () => JSON.stringify({ ...ns, shot: true }))
      const tdir = (await $.env.get('TMPDIR').catch(() => undefined)) || '/tmp'
      args.push('--sheet', `${tdir}/relay-sheet-${appId}-${Date.now()}.png`)
    }
    await openPane($)
    await update($, loop, (): RelayLine[] => [{ text: `⟳ 画面チェック中 アプリ ${appId}${actions ? `(手順 ${actions.length})` : ''}`, tone: 'dim' }])
    const r = await runToolSafe($, 'kin-probe.mjs', args)
    await update($, loop, () => formatProbe(r.json, r.raw))
    if (!(r.json && (r.json.pages || r.json.skipped || r.json.actions))) {
      // 時間切れなどで JSON が無い時も、縮小1枚が作れなかったことは黙らない
      const err = JSON.parse(toolError(r.json, r.raw)) as { error: { message?: string } }
      if (sheetAsked) err.error.message = `${err.error.message ?? ''}${r.raw.timedOut ? '(時間切れ)' : ''} 縮小1枚は作れませんでした${r.raw.timedOut ? '(時間切れ)' : ''}`
      return safeJson(err)
    }
    const sheet = typeof r.json.sheet === 'string' ? r.json.sheet : ''
    const shown = Array.isArray(r.json.sheetPages) && r.json.sheetPages.length ? (r.json.sheetPages as unknown[]).map(String).join('・') : actions ? '最後の画面' : '設定・詳細・一覧'
    const sheetLine = sheet
      ? `\n\n縮小1枚(${shown}): ${sheet}\nRead で見て、崩れがあれば直す(縮小1枚は1回の画面チェックにつき1枚)。`
      : sheetAsked ? `\n\n縮小1枚は作れませんでした${typeof r.json.sheetError === 'string' ? `(${r.json.sheetError})` : r.raw.timedOut ? '(時間切れ)' : ''}` : ''
    return digestProbe(appId, r.json, r.raw) + sheetLine
  } finally {
    await rmTmp($, tmp)
  }
}

async function recordsWriteTool($: EngineInterface, i: Record<string, unknown>): Promise<string> {
  const appId = str(i.appId)
  if (need(appId)) return need(appId)!
  const tag = str(i.tag)
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(tag)) return safeJson({ ok: false, error: { code: 'bad_input', message: 'tag は英数字と - _ だけ(40字まで)' } })
  const rows = i.rows
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 20 || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r)))
    return safeJson({ ok: false, error: { code: 'bad_input', message: 'rows は {フィールドコード: 値} の配列(1〜20 行)' } })
  const g = await recordsGate($, appId)
  if (!g.go) return g.text
  const tmp = await writeTmp($, 'rows', rows)
  try {
    const r = await exclusive(() => runToolSafe($, 'kin-records.mjs', ['write', appId, '--rows', tmp, '--tag', tag]))
    if (!r.json?.ok) return toolError(r.json, r.raw)
    await refreshTestCount($, appId)
    return safeJson({ ok: true, appId, tag, ids: r.json.ids ?? [], note: '片付けは kin_records_cleanup(または 次の一手 8)' })
  } finally {
    await rmTmp($, tmp)
  }
}

async function recordsCleanupTool($: EngineInterface, i: Record<string, unknown>): Promise<string> {
  const appId = str(i.appId)
  if (need(appId)) return need(appId)!
  const tag = str(i.tag)
  if (tag && !/^[A-Za-z0-9_-]{1,40}$/.test(tag)) return safeJson({ ok: false, error: { code: 'bad_input', message: 'tag は英数字と - _ だけ(40字まで)' } })
  const g = await recordsGate($, appId)
  if (!g.go) return g.text
  const r = await exclusive(() => runToolSafe($, 'kin-records.mjs', ['cleanup', appId, ...(tag ? ['--tag', tag] : [])]))
  if (!r.json?.ok) return toolError(r.json, r.raw)
  await refreshTestCount($, appId)
  return safeJson({ ok: true, appId, deleted: r.json.deleted, missing: r.json.missing, remaining: r.json.remaining })
}

// フォームの変更の適用(確認の後)。pane・digest を更新し、結果を返す
async function formChangeNow($: EngineInterface, appId: string, ops: unknown[]): Promise<ToolOut> {
  await openPane($)
  await update($, loop, (): RelayLine[] => [{ text: `⟳ フォーム変更中 アプリ ${appId}`, tone: 'head' }])
  const tmp = await writeTmp($, 'ops', ops)
  try {
    const r = await runToolSafe($, 'kin-loop.mjs', ['form-change', appId, '--ops', tmp])
    await update($, loop, () => formatFormChange(appId, r.json, r.raw))
    await update($, report, () => redact(`mod からの報告: アプリ ${appId} のフォーム変更 ${r.json?.ok ? 'を反映しました' : 'は途中で止まりました(pane に詳細)'}`).slice(0, 300))
    await pushDigest($, 'form-change', digestFormChange(appId, r.json, r.raw))
    if (!r.json?.ok) $.ui.toast(`✗ フォーム変更失敗 アプリ ${appId}`)
    return r
  } finally {
    await rmTmp($, tmp)
  }
}

const FORM_OP_KINDS = ['add', 'label', 'lookup', 'layoutRow']

async function formChangeTool($: EngineInterface, i: Record<string, unknown>): Promise<string> {
  const appId = str(i.appId)
  if (need(appId)) return need(appId)!
  const ops = i.ops
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 30) return safeJson({ ok: false, error: { code: 'bad_input', message: 'ops は 1〜30 個の配列' } })
  for (const [k, o] of ops.entries()) {
    const keys = o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o as object) : []
    if (keys.length !== 1 || !FORM_OP_KINDS.includes(keys[0]!) || (o as Record<string, unknown>)[keys[0]!] === null)
      return safeJson({ ok: false, error: { code: 'bad_input', message: `ops[${k}] は ${FORM_OP_KINDS.join(' / ')} のどれか1つ。欄の削除とルックアップの解除はしません(人が画面で)` } })
  }
  const g = await recordsGate($, appId, 'フォームの変更は')
  if (!g.go) return g.text
  const tmp = await writeTmp($, 'ops', ops)
  let r: ToolOut
  try {
    r = await runToolSafe($, 'kin-loop.mjs', ['form-change', appId, '--ops', tmp, '--plan'])
  } finally {
    await rmTmp($, tmp)
  }
  if (!r.json?.ok) {
    await openPane($)
    await update($, loop, () => formatFormChange(appId, r.json, r.raw))
    return toolError(r.json, r.raw)
  }
  const plan = planList(r.json)
  const warnings = planWarnings(r.json)
  await setPending($, { kind: 'form', appId, ops, plan: [...plan, ...warnings.map(w => `注意: ${w}`)] })
  return safeJson({
    status: 'awaiting_human_confirmation',
    message: `アプリ ${appId} のフォーム変更 ${plan.length} 件は人の確認待ちです。画面のボタンか /kin ok で実行します(確認は1回だけ・待つだけで再試行不要)`,
    plan,
    warnings,
  })
}
async function backupsTool($: EngineInterface, i: Record<string, unknown>): Promise<string> {
  const appId = str(i.appId)
  if (need(appId)) return need(appId)!
  return readTool($, 'kin-loop.mjs', ['backups', appId], j => mdBackups(appId, j))
}

// prompt.compose で足す「見た目の決まり」(README の「作られる物の見た目」と同じ内容)
const LOOKS_TEXT = `# kintone プラグインの見た目の決まり(プラグイン作成 mod)
kintone のプラグインを作る・直す時は、kintone 標準の見た目に合わせる。
- 設定画面は同梱の 51-modern-default(kintone 公式)の kintoneplugin-* クラスで組み、項目は同梱の relay-config の部品で作る(RelayConfig.mount に項目を渡す。fieldSelect・fieldChecks・viewSelect・viewChecks・appSelect・optionChecks・numberInput・textInput・rowsTable)。欄・一覧・アプリを文字で打たせない。51-modern-default のクラス: 項目名 kintoneplugin-label・必須 kintoneplugin-require・説明 kintoneplugin-desc・選択 kintoneplugin-select-outer・入力 kintoneplugin-input-outer / kintoneplugin-input-text・右下に kintoneplugin-button-dialog-cancel と kintoneplugin-button-dialog-ok。保存は setConfig(コールバック省略でプラグイン一覧へ戻る)。
- 本体は同梱の relay-ui の4部品を使う: RelayUI.headerButton(ヘッダーのボタン)・RelayUI.band(一覧の上の帯)・RelayUI.notice(詳細の注意書き)・RelayUI.panel(小さなパネル)。独自の CSS で色・影・角丸を足さない。フォントサイズ・余白は kintone に任せる。
- 文言は機能名。製品名・会社名を画面に出さない。
- エラーと注意は kintoneplugin-alert。
- kintone の内部 DOM に触らない(公式 API が返す要素と自分の要素だけ)。
- 反映後に kin_probe を screenshots: true で1回だけ呼び、縮小1枚を見て崩れがあれば直す。2回目は見ない。`
const LOOKS = { id: 'plugbits-relay:looks', text: LOOKS_TEXT, scope: 'session' } as const

const formChangeEnabled = async ($: EngineInterface) => (await $.env.get('RELAY_FORM_CHANGE').catch(() => undefined)) === '1'

// 名前から道具の処理へ($ は関数宣言の呼び出しでだけ渡す)
async function invoke($: EngineInterface, name: string, i: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'kin_status': return statusTool($)
    case 'kin_apps': return appsTool($)
    case 'kin_form': return formTool($, i)
    case 'kin_plugins': return pluginsTool($, i)
    case 'kin_records': return recordsTool($, i)
    case 'kin_probe': return probeTool($, i)
    case 'kin_records_write': return recordsWriteTool($, i)
    case 'kin_records_cleanup': return recordsCleanupTool($, i)
    case 'kin_form_change': return (await formChangeEnabled($)) ? formChangeTool($, i) : safeJson({ ok: false, error: { code: 'not_enabled', message: 'kin_form_change は試験中です(RELAY_FORM_CHANGE=1 で起動した時だけ使えます)' } })
    case 'kin_backups': return backupsTool($, i)
    case 'kin_scaffold': return scaffoldTool($, i)
    case 'kin_deploy': return deployTool($, i)
    case 'kin_undo': return undoTool($, i)
    case 'kin_customize': return customizeTool($, i)
    default: return safeJson({ ok: false, error: { code: 'unknown_tool', message: name } })
  }
}

const fileList = { type: 'array', items: { type: 'string' } }

const TOOLS: ToolDef[] = [
  {
    name: 'kin_status',
    description: `kintone 接続先の状態(接続先の名前・開発/本番・ホスト・本番許可アプリ・relay の版・控えの数)。読むだけ。パスワードは返さない。 Connection status (dev/prod, host, prod apps, backups). Read-only. ${LOOP}`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kin_apps',
    description: 'kintone のアプリ一覧(id・名前・スペース)。読むだけ。 List apps (read-only).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kin_form',
    description: 'アプリのフィールド(code・label・type・必須・選択肢・サブテーブル・重複禁止 unique・既定値 defaultValue・ルックアップ lookup=参照先アプリ/キー/コピー先・関連レコード referenceTable)と一覧(views: 名前と ID。relay.config.json で一覧を指定する時は ID)。プラグインを書く前に見る。読むだけ。 Fields (with required, unique, defaultValue, lookup, referenceTable) and views of an app (read-only). Start here.',
    inputSchema: { type: 'object', properties: { appId: appIdSchema }, required: ['appId'] },
  },
  {
    name: 'kin_plugins',
    description: 'アプリに付いているプラグインと JS/CSS。読むだけ。 Plugins and customize JS/CSS of an app (read-only).',
    inputSchema: { type: 'object', properties: { appId: appIdSchema }, required: ['appId'] },
  },
  {
    name: 'kin_records',
    description: 'レコードを読むだけ(実データの形を見る用)。limit は20まで。 Read records (read-only, limit <= 20).',
    inputSchema: {
      type: 'object',
      properties: {
        appId: appIdSchema,
        query: { type: 'string', description: 'kintone のクエリ / query string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        fields: { type: 'array', items: { type: 'string' }, description: '取るフィールドコード / field codes' },
      },
      required: ['appId'],
    },
  },
  {
    name: 'kin_probe',
    description: '画面チェック(設定・詳細・一覧)。console.error・未捕捉例外・events(発火回数・登録数・読み込み回数)を返す。actions を渡すと画面を操作できる(1ページで手順を順に・最大30・1手順が失敗したらそこで止まる): {open:"detail"|"index"|"config"|"create"|"edit", record?:id} / {click:"text=…"} か {click:{role,name}} / {fill:{label,value}} / {select:{label,value}}(ラベルの無い選択欄は {select:{value:"選択肢の文字"}}。部分一致で選ぶ) / {press:"Enter"} / {save:true} / {expect:{text, exact?}}(exact: true で文字全体の一致だけ。項目名の一部に当たる偽陽性を避ける) / {wait:ms} / {read:true}。欄はラベルで探す(CSS・内部 DOM は使えない)。返り値に各手順の成否・開いたレコード id と URL・最後の画面(ダイアログ本文・ボタン名・項目名)。fill/select/press/save/click は書き込みなので開発環境だけ(本番は拒否)。open/expect/wait/read は本番でも可。screenshots: true で見た目の縮小1枚(1回の呼び出しにつき最大1枚。actions の時は最後の画面)。実行は最長240秒。 Browser check; with actions it can operate the screen (dev only for writes).',
    inputSchema: {
      type: 'object',
      properties: {
        appId: appIdSchema,
        pages: { type: 'array', items: { enum: ['config', 'detail', 'index'] } },
        pluginId: { type: 'string', description: '設定画面も開く時のプラグイン ID(kin_deploy の結果にある) / plugin id to open its config page' },
        screenshots: { type: 'boolean', description: 'true で縮小1枚(横 1080px 以下・最大2コマ)のパスを返す。既定オフ。1回の呼び出しにつき最大1枚 / one downsized sheet per call' },
        actions: {
          type: 'array',
          maxItems: 30,
          items: { type: 'object', description: '手順1つ。キーはどれか1つ: open / click / fill / select / press / save / expect / wait / read' },
          description: '画面の操作の手順(pages は無視して1ページで流す)。例: [{open:"detail",record:47},{click:"text=マスターを整える"},{fill:{label:"品番",value:"ZZ-999"}},{save:true},{expect:{text:"未登録",exact:true}}] / steps to run on one page',
        },
      },
      required: ['appId'],
    },
  },
  {
    name: 'kin_backups',
    description: '反映前の控えの一覧(時刻・プラグイン・版)。kin_undo で戻せるもの。読むだけ。 Backups list (read-only).',
    inputSchema: { type: 'object', properties: { appId: appIdSchema }, required: ['appId'] },
  },
  {
    name: 'kin_scaffold',
    description: `plugins/<name>/ にプラグインのひな形を作る(ローカルのファイルだけ)。appId を付けるとそのフォームのフィールドを入れる。kind: event(events の型)| config-only(設定だけ)| header-button(一覧のヘッダーにボタン→パネル)| index-band(一覧の上の帯に件数・合計)| detail-notice(詳細の上に注意書き)。設定画面は kintone 公式の 51-modern-default、本体は relay-ui の部品入り。 Scaffold plugins/<name>/ (local files only). ${LOOP}`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, kind: { enum: SCAFFOLD_KINDS }, appId: appIdSchema },
      required: ['name', 'kind'],
    },
  },
  {
    name: 'kin_deploy',
    description: 'plugins/<name>/ を(relay.config.json に build があれば先にビルドして)pack→上げる→アプリに追加→反映し、画面チェックまで返す。ビルドが失敗したら反映せず出力の末尾20行を返す。appId に "65,53" のようにカンマ区切りで複数アプリを渡せる(開発だけ。プラグイン本体の更新は1回・各アプリへは1回ずつ。本番は1アプリずつ)。開発は即時。本番は人の確認待ちで止まる(待つだけ・再試行不要)。プラグインの設定値は plugins/<name>/relay.config.json に {"キー": "値"}(config.js が setConfig するキー)を書いてから呼ぶと設定値 API で入る。結果の config の段で入ったか分かる。relay.config.json が前回と同じなら設定値は送らず、設定画面で選んだ値を残す。設定画面での保存はアプリの更新(この反映)まで本体に出ないので、ユーザーが画面で選び直したら relay.config.json は触らずにこの道具で反映する。 Deploy a plugin dir to an app. Dev runs now; prod waits for a human to confirm. To set plugin config, write plugins/<name>/relay.config.json first.',
    inputSchema: {
      type: 'object',
      properties: {
        pluginDir: { type: 'string', description: 'plugins/<name> (作業フォルダ配下) / under cwd plugins/' },
        appId: { type: 'string', description: 'kintone のアプリ番号 (例 "42")。開発だけ複数: "65,53" / app id, or comma list (dev only)' },
        appIds: { type: 'array', items: { type: 'string' }, description: 'appId の代わりに配列で(開発だけ) / alternative to a comma list' },
      },
      required: ['pluginDir'],
    },
  },
  {
    name: 'kin_records_write',
    description: '試験用のレコードを作る(開発環境だけ。本番は拒否)。rows は {フィールドコード: 値} の配列(最大20行・サブテーブルは対象外)。作った id は tag つきで記録され、kin_records_cleanup で消せる。画面チェック(kin_probe の actions)の前に実データの形を用意する用。 Create test records (dev only), recorded under a tag for cleanup.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: appIdSchema,
        rows: { type: 'array', maxItems: 20, items: { type: 'object' }, description: '[{フィールドコード: 値}] / field code → value' },
        tag: { type: 'string', description: '英数字と - _ だけ(40字まで)。片付けの目印 / cleanup tag' },
      },
      required: ['appId', 'rows', 'tag'],
    },
  },
  {
    name: 'kin_records_cleanup',
    description: 'kin_records_write で作った試験用レコードを消す(記録した id だけ。開発環境だけ・本番は拒否)。tag を付けるとその tag だけ。 Delete the test records this mod created (dev only).',
    inputSchema: { type: 'object', properties: { appId: appIdSchema, tag: { type: 'string', description: '片付ける tag(省略で全部) / only this tag' } }, required: ['appId'] },
  },
  {
    name: 'kin_form_change',
    description: 'アプリのフォームを変える(開発環境だけ。本番は拒否)。ops: {add:{code,type,label,required?,unique?,options?,defaultValue?…}} / {label:{code,label}} / {lookup:{code,relatedApp,relatedKeyField,fieldMappings:[{field,relatedField}],lookupPickerFields?}}(既存の欄にルックアップを付ける) / {layoutRow:{fields:[code…]}}(欄を新しい行に)。欄の削除とルックアップの解除はできない(人が画面で)。呼ぶとまず「変更の一覧」を返して人の確認待ちで止まる(確認は1回・画面のボタンか /kin ok・待つだけで再試行不要)。確認後に反映され、実行前のフォームは控えられる。 Change the form (dev only): add fields, rename labels, attach lookups, add layout rows. No field deletion, no lookup removal. Returns a plan and waits for one human confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: appIdSchema,
        ops: { type: 'array', maxItems: 30, items: { type: 'object', description: 'どれか1つ: add / label / lookup / layoutRow' } },
      },
      required: ['appId', 'ops'],
    },
  },
  {
    name: 'kin_undo',
    description: '直前の反映を控えから戻す。開発は即時。本番は人の確認待ち。戻せない時は理由を返す。 Undo the last deploy from backup. Prod waits for a human.',
    inputSchema: { type: 'object', properties: { appId: appIdSchema }, required: ['appId'] },
  },
  {
    name: 'kin_customize',
    description: 'プラグインでない JS/CSS カスタマイズを設定する(作業フォルダ内のファイル)。開発は即時。本番は人の確認待ち。 Set non-plugin customize JS/CSS (files under cwd). Prod waits for a human.',
    inputSchema: {
      type: 'object',
      properties: { appId: appIdSchema, js: fileList, css: fileList, mobileJs: fileList, mobileCss: fileList },
      required: ['appId'],
    },
  },
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (typeof (e as { cwd?: unknown }).cwd === 'string') startCwd = (e as { cwd: string }).cwd
    await $.command.register({
      name: 'kin',
      // v1.1 候補は1行だけ。副命令(setup・use・status・doctor・connect・undo・next・ok・cancel)はそのまま効く。README と pane から辿る
      description: 'kintone の作業台を開く(接続・アプリ・反映)',
      argumentHint: '[アプリ番号]',
    })
    // kin_form_change は本物での通しが済むまで、RELAY_FORM_CHANGE=1 の時だけ出す(v0.8 の時点で適用は未通し)
    const formChangeOn = await formChangeEnabled($)
    for (const t of TOOLS) {
      if (t.name === 'kin_form_change' && !formChangeOn) continue
      await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
    }
    return next(e)
  })

  on('command.run', { command: 'kin' }, async ($, e) => {
    const arg = e.args.trim()
    await openPane($)
    // 帯の接続先(名前と種別だけ)がまだ無ければ、最初の /kin で一度読む。待たない(status は自分で読む)
    // setup は除く(/kin setup <文字> の誤入力では何も起動しない)
    if (!(await read($, connAtom)) && arg !== 'status' && !/^setup\b/.test(arg)) {
      void runToolSafe($, 'kin-profile.mjs', ['status']).then(r => (r.json?.ok ? setConn($, String(r.json.name ?? ''), String(r.json.mode ?? '')) : undefined)).catch(() => undefined)
    }

    // 確認(本番): ボタンが出ない端末(スマホ)用の文字の入口
    if (arg === 'ok' || arg === 'cancel') {
      const t = arg === 'ok' ? await confirmYes($) : await confirmNo($)
      return { text: t ?? 'kin: 確認待ちはありません' }
    }

    if (arg === 'setup') {
      await openSetup($)
      return { text: 'kin: pane に接続設定の入力欄を出しました。パスワードは会話に書かず、pane の欄に入れてください(欄の文字は会話に残りません)' }
    }
    if (/^setup\s/.test(arg)) {
      return { text: 'kin: /kin setup には何も付けないでください。いま入力した文字は会話に残っています(パスワードを書いたなら変更を)。入力は pane の欄で' }
    }

    const use = /^use(?:\s+(\S+))?$/.exec(arg)
    if (use) {
      if (!use[1]) {
        const r = await runToolSafe($, 'kin-profile.mjs', ['list'])
        const lines = formatProfiles(r.json, r.raw)
        await update($, main, () => lines)
        return { text: `kin: 使い方 /kin use <id>\n\n${r.json?.ok ? mdProfiles(r.json) : (lines[1]?.text ?? '')}` }
      }
      return { text: await useRequest($, use[1]) }
    }

    if (arg === 'status') {
      await update($, main, (): RelayLine[] => [{ text: '⟳ 接続先を確認中…', tone: 'dim' }])
      const r = await runToolSafe($, 'kin-profile.mjs', ['status'])
      // 入っている mod の版も出す(入れ直した後に新しい版か分かるように)。読めなければ出さない
      if (r.json?.ok) {
        const ver = await $.fs.read(`${$.plugin.root}/package.json`).then(t => String(JSON.parse(t).version ?? ''), () => '')
        if (ver) (r.json as Record<string, unknown>).relayVersion = ver
      }
      const lines = formatConnStatus(r.json, r.raw)
      await update($, main, () => lines)
      if (r.json?.ok && (r.json.mode === 'dev' || r.json.mode === 'prod')) await update($, envMode, () => String(r.json?.mode))
      if (r.json?.ok) await setConn($, String(r.json.name ?? ''), String(r.json.mode ?? ''))
      const md = mdConnStatus(r.json, r.raw)
      await pushDigest($, 'conn', md)
      return { text: `${lines[0]?.text ?? ''}\n\n${md}` }
    }

    if (arg === 'doctor') {
      await update($, main, (): RelayLine[] => [{ text: '⟳ 診断中…', tone: 'dim' }])
      const r = await runToolSafe($, 'kin-doctor.mjs', [])
      const lines = formatDoctor(r.json, r.raw)
      await update($, main, () => lines)
      const md = mdDoctor(r.json, r.raw)
      await pushDigest($, 'doctor', md)
      return { text: `${lines[0]?.text ?? ''}\n\n${md}` }
    }

    const nx = /^next(?:\s+(\S+))?$/.exec(arg)
    if (nx) {
      const n = parseNextNumber(nx[1] ?? '')
      return { text: n ? await runNextShown($, n) : 'kin: 使い方 /kin next <番号>(反映の後に出る一覧の番号)' }
    }

    const undo = /^undo(?:\s+(\d+))?$/.exec(arg)
    if (undo) {
      const appId = undo[1] ?? (await read($, target))
      if (!appId) return { text: 'kin: 使い方 /kin undo <appId>(アプリ番号が必要です)' }
      return { text: await undoRequest($, appId) }
    }

    // v1.1 /kin だけ: 作業台の pane を開くだけ(未選択なら pane が「はじめに」を出す)。使い方の文字は返さない
    if (arg === '') return {}

    if (arg === 'connect') {
      await update($, main, (): RelayLine[] => [{ text: '⟳ アプリ一覧を取得中…', tone: 'dim' }])
      const r = await runToolSafe($, 'kin-loop.mjs', ['apps'])
      const missing = r.json?.error?.code === 'missing'
      const lines = missing
        ? [{ text: SETUP_NEEDED, tone: 'head' as const }, ...formatApps(r.json, r.raw)]
        : formatApps(r.json, r.raw)
      await update($, main, () => lines)
      if (r.json?.mode) await update($, envMode, () => String(r.json?.mode))
      // ② 同じ内容を文字でも: 次のプロンプトの context と、この command の出力(すぐ見える)の両方へ
      const md = digestApps(r.json, r.raw)
      await pushDigest($, 'apps', md)
      return {
        text: `${
          r.json?.ok
            ? `kin: アプリ ${(r.json.apps ?? []).length} 件を pane に出しました`
            : missing
              ? `kin: 接続先がありません。${SETUP_NEEDED}`
              : `kin: 接続できません。${lines[1]?.text ?? ''}`
        }\n\n${md}`,
      }
    }

    if (/^\d+$/.test(arg)) {
      await update($, main, (): RelayLine[] => [{ text: `⟳ アプリ ${arg} のフォームを取得中…`, tone: 'dim' }])
      const r = await runToolSafe($, 'kin-loop.mjs', ['form', arg])
      const lines = formatForm(arg, r.json, r.raw)
      await update($, main, () => lines)
      const md = digestForm(arg, r.json, r.raw)
      await pushDigest($, 'form', md)
      if (r.json?.ok) {
        await update($, target, () => arg)
        const fm: FormMapData = {
          appId: arg,
          ...(typeof r.json.appName === 'string' ? { appName: r.json.appName } : {}),
          fields: (r.json.fields ?? []) as FormMapData['fields'],
          ...(Array.isArray(r.json.layout) ? { layout: r.json.layout as FormMapData['layout'] } : {}),
          // 名前だけ(ID は pane に出さない)
          plugins: ((r.json.plugins ?? []) as Record<string, unknown>[]).map(p => String(p.name ?? '')),
          views: ((r.json.views ?? []) as Record<string, unknown>[]).map(v => String(v.name ?? '')),
        }
        await update($, formMapAtom, () => JSON.stringify(fm))
        await update($, formOpenAtom, () => '')
        await patchPaneUi($, v => ({ ...v, pick: false }))
        await clearNext($)
        if (r.json.mode) await update($, envMode, () => String(r.json?.mode))
        // v0.9.1 デスクトップ・スマホ: 表は会話に出さない(pane の地図と二重になる)。モデルには digest が次の context で届く
        if (!(await onlyTerminal($))) {
          return { text: `kin: 反映先をアプリ ${arg}${fm.appName ? ` ${fm.appName}` : ''} にしました${r.json.mode === 'prod' ? '(本番)' : ''}。フォームは右の pane にあります` }
        }
        return { text: `kin: 反映先をアプリ ${arg} にしました(plugins/<name>/ の保存で自動反映)\n\n${md}` }
      }
      return { text: `kin: アプリ ${arg} を読めません。${lines[1]?.text ?? ''}\n\n${md}` }
    }

    return {
      text: 'kin: 使い方 /kin setup(接続設定)・/kin use <id>(接続先を切り替え)・/kin status・/kin doctor・/kin connect(アプリ一覧)・/kin <appId>(フォームを見て反映先にする)・/kin undo <appId>(直前の反映を戻す)・/kin ok / /kin cancel(本番の確認)',
    }
  })

  // 道具の呼び出しに答える。例外は秘密を伏せた JSON にして返す
  for (const t of TOOLS) {
    on('tool.call', { tool: new RegExp(`^${TOOL_PREFIX}${t.name}$`) }, async ($, e) => {
      let text: string
      try {
        text = redact(await invoke($, t.name, e as unknown as Record<string, unknown>))
      } catch (err) {
        text = safeJson({ ok: false, error: { code: 'tool_failed', message: err instanceof Error ? err.message : String(err) } })
      }
      return { result: text }
    }).catch(() => ({ result: safeJson({ ok: false, error: { code: 'tool_failed', message: 'relay の道具が失敗しました' } }) }))
  }

  // plugins/<name>/ 配下の Edit/Write を見張る。ツールは止めない・拒否しない
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) schedulePlugin($, e.file_path)
    return ran
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) schedulePlugin($, e.file_path)
    return ran
  }).catch(($, e, next) => next(e))

  // 関門の迂回を塞ぐ: 本番の確認は人だけが通す。Bash から書く系の CLI を直に叩く・接続情報を読む のを止める
  const SECRET_PATH = /kintone\.env|tiny-pulse\/kintone|relay-backup|\.ppk\b|X-Cybozu-Authorization/i
  const DIRECT_WRITE = /(kin-loop\.mjs\b[^\n|;&]*\b(deploy|undo|customize|form-change)|kin-profile\.mjs\b[^\n|;&]*\b(save|use|delete)|kin-records\.mjs\b[^\n|;&]*\b(write|cleanup))\b/
  const guardDeny = (what: string) => ({ deny: `${'plugbits-relay'}: ${what} は プラグイン作成 mod の道具(kin_*)から行ってください。本番の確認を人に残すため、直接は止めています` })
  on('tool.call', { tool: 'Bash' }, ($, e, next) =>
    SECRET_PATH.test(e.command) ? guardDeny('接続情報・控え・鍵への直接アクセス')
      : DIRECT_WRITE.test(e.command) ? guardDeny('kin-loop / kin-profile / kin-records の書き込み(deploy・undo・customize・form-change・save・use・delete・write・cleanup)')
      : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : guardDeny('ガードの失敗につき、この操作')))
  on('tool.call', { tool: 'Read' }, ($, e, next) =>
    SECRET_PATH.test(e.file_path) ? guardDeny('接続情報・控え・鍵の読み取り') : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : guardDeny('ガードの失敗につき、この操作')))

  // 見た目の決まり: この mod が有効な間、システムプロンプトの末尾に1節(session 側)
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const rest = r.sections.filter(x => x.id !== LOOKS.id && x.id !== START_COMPOSE.id)
    // v1.1 反映先が未選択の間だけ「最初の返事は3択」を足す。決まったら外れる
    const start = (await read($, target)) ? [] : [{ ...START_COMPOSE, scope: 'session' as const }]
    return { sections: [...rest, LOOKS, ...start] }
  }).catch(($, e, next) => next(e))

  // 会話への戻し: 次のプロンプトに「mod からの報告」(1 行)と、pane と同じ内容の短い Markdown(②)を context として添える(画面には出ない)
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    // 素の番号(1〜8・全角可)だけの入力は、一覧が出ている時に限って mod が処理する。モデルの手番は起こさない
    const k = e.origin?.kind // 付いていなければ本人の入力として扱う(型の説明どおり)
    const n = k === undefined || k === 'composer' || k === 'bridge' ? parseNextNumber(e.text) : 0
    if (n && !(await readPending($)) && (await readNext($))) {
      const t = await runNextShown($, n)
      if (await onlyTerminal($)) {
        // 端末: 今までどおりモデルの手番を使わない。結果はログ行と pane
        await logLines($, t)
        // 落とした入力は入力欄に戻るので、少し後で空にする(残ると次に打つ字が番号の後ろに付く)
        void $.clock.sleep(300).then(() => $.prompt.fill({ text: '', mode: 'replace' })).catch(() => undefined)
        return { drop: `次の一手 ${n} を実行しました` }
      }
      // v0.9 デスクトップ・スマホ: 番号を捨てない(捨てると何も見えない)。実行済みの結果をモデルに渡し、そのまま伝えてもらう
      const tag = '[プラグイン作成 mod の自動報告。ユーザーの発言ではありません]'
      return next({
        ...e,
        context: [...(e.context ?? []), `${tag} ユーザーが次の一手 ${n} を選び、mod が実行済みです。もう一度実行せず、下の結果をそのままユーザーに見せてください(URL は省かない)。\n\n${t}`],
      })
    }
    const line = await read($, report)
    const blocks = await read($, digest)
    if (!line && blocks.length === 0) return next(e)
    if (line) await update($, report, () => '')
    if (blocks.length) await update($, digest, (): Digest[] => [])
    const tag = '[プラグイン作成 mod の自動報告。ユーザーの発言ではありません]'
    const labeled = line ? (line.startsWith('mod からの報告') ? line : `mod からの報告: ${line}`) : ''
    return next({
      ...e,
      context: [
        ...(e.context ?? []),
        ...(labeled ? [`${tag} ${labeled}`] : []),
        ...blocks.map(b => `${tag}\n${b.md}`),
      ],
    })
  }).catch(($, e, next) => next(e))

  // 足元の帯: 接続先・アプリ・最後の反映・エラー数。本番の確認待ちの間は [反映] [やめる]
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const el = $.ui.resolve(e) as any
    return renderBand(el, e.surface, await bandView($), {
      onOk: () => void confirmYes($),
      onCancel: () => void confirmNo($),
      onUndo: () => void read($, undoOfferAtom).then(id => (id ? update($, undoOfferAtom, () => '').then(() => undoRequest($, id)) : undefined)).catch(() => undefined),
    })
  })

  // v1.0 本番の関所(小さなダイアログ)。開いた時の材料が無い(読み直し後など)なら確認待ちから組み直す
  on('ui.render', { component: 'Pane', requestId: GATE }, async ($, e) => {
    const el = $.ui.resolve(e) as any
    const pend = await readPending($)
    if (!pend) return <el.Text dimColor>確認待ちはありません</el.Text>
    const v = gateView ?? gateLines({ kind: pend.kind, appId: pend.appId, ...(pend.name ? { name: pend.name, profileName: pend.name } : {}), ...(pend.plan ? { plan: pend.plan } : {}) })
    return renderGate(el, e.surface, v, { onOk: () => void confirmYes($), onCancel: () => void confirmNo($) })
  })
  // Esc・閉じるで消したら「やめる」と同じ(何も変えない)。mod 自身が閉じた時は何もしない
  on('ui.close', async ($, e, next) => {
    if (e.id === GATE && e.origin?.kind === 'person') {
      gateView = null
      await confirmNo($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e) as any
    const { Box, Button, Text, Input, Select } = el
    const sv = await readSetup($)
    const band = await bandView($)
    const pulse = await readPulse($)
    const fmRaw = parseOr<FormMapData | null>(await read($, formMapAtom), null)
    const app = await read($, target)
    const mode = await read($, envMode)
    const pend = await readPending($)
    const nx = pend ? null : await readNext($)
    const top = await read($, main)
    const bottom = await read($, loop)
    const fm = fmRaw && fmRaw.appId === app ? fmRaw : null
    // v0.9.1 デスクトップ・スマホ・VS Code: 欄の文字一覧は地図に置き換える(プラグイン・一覧は1行に畳む)
    const wide = e.surface !== 'terminal'
    const formTop = wide && !!fm && top[0]?.text === formHead(fm.appId)
    const opened = wide ? await read($, formOpenAtom) : ''
    // 端末は行数を数える(鼓動の段1・合計1・エラーは1件2行+前後3行で見積もる)。デスクトップは縦に伸びるので数えない
    const pulseRows = pulse ? 2 + pulse.errors.length * 9 + (pulse.result ? pulse.result.md.split('\n').length + 1 : 0) : 0
    const room = Math.max(6, (e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 24) - 4) - 4 - (sv.open ? 16 : 0) - (e.surface === 'terminal' ? pulseRows : 0))

    const bottomRows = Math.min(bottom.length, Math.max(Math.floor(room / 2), room - top.length))
    const topRows = Math.max(0, room - bottomRows - 1)
    const topShown = top.slice(0, topRows)
    const cut = top.length - topShown.length

    const row = (l: RelayLine, i: number) => (
      <Text
        key={`${i}`}
        dimColor={l.tone === 'dim'}
        color={l.tone === 'ok' ? 'green' : l.tone === 'err' ? 'red' : undefined}
        weight={l.tone === 'head' ? 'bold' : undefined}
      >
        {l.text}
      </Text>
    )

    const pendEl = pend && (
          <Box flexDirection="column">
            <Text weight="bold">
              {pendingHeadline(pend)}
            </Text>
            <Box>
              <Button key="confirm-ok" label={pend.kind === 'use' ? '切り替える' : pend.kind === 'form' ? '実行' : '反映'} variant="primary" onPress={() => void confirmYes($)} />
              <Text> </Text>
              <Button key="confirm-cancel" label="やめる" onPress={() => void confirmNo($)} />
            </Box>
            <Text dimColor>ボタンが出ない端末では /kin ok か /kin cancel</Text>
          </Box>
        )
    const setupEl = sv.open && (
          <Box flexDirection="column">
            <Text weight="bold">接続設定</Text>
            {Input && e.surface !== 'mobile' ? (
              <Box flexDirection="column">
                <Text dimColor>入力中は画面に見えます。会話には残りません</Text>
                <Input key="f-name" label="名前 " placeholder="例: 開発" value={form.name} onInput={(v: string) => { form.name = v }} onSubmit={(v: string) => { form.name = v }} />
                <Input key="f-subdomain" label="サブドメイン " placeholder={e.surface === 'terminal' ? '例: mycompany' : '例: example(.cybozu.com の前)'} value={form.subdomain} onInput={(v: string) => { form.subdomain = v }} onSubmit={(v: string) => { form.subdomain = v }} />
                <Select key="f-domain" label="ドメイン " options={DOMAINS.map(d => ({ value: d, label: d }))} value={form.domain} onSelect={(v: string) => { form.domain = v }} />
                <Input key="f-username" label="ログイン名 " placeholder={e.surface === 'terminal' ? undefined : '例: relay-dev'} value={form.username} onInput={(v: string) => { form.username = v }} onSubmit={(v: string) => { form.username = v }} />
                <Input key={`f-password-${sv.rev}`} label="パスワード " placeholder={pwSent || form.password ? '設定済み(再入力で上書き)' : undefined} submitLabel="保存" value="" onInput={(v: string) => { form.password = v }} onSubmit={(v: string) => { if (v) form.password = v; void saveSetup($) }} />
                <Select key="f-kind" label="種別 " options={[{ value: 'dev', label: '開発' }, { value: 'prod', label: '本番' }]} value={form.kind} onSelect={(v: string) => { form.kind = v }} />
                <Input key="f-apps" label="本番のアプリ番号 " placeholder="反映してよい番号をカンマ区切りで" value={form.apps} onInput={(v: string) => { form.apps = v }} onSubmit={(v: string) => { form.apps = v; void saveSetup($) }} submitLabel="保存" />
                <Box>
                  <Button key="setup-save" label="保存" variant="primary" onPress={() => void saveSetup($)} />
                  <Text> </Text>
                  <Button key="setup-close" label="閉じる" onPress={() => void patchSetup($, v => ({ ...v, open: false }))} />
                </Box>
              </Box>
            ) : (
              <Text dimColor>この画面には入力欄がありません。ターミナルかデスクトップで /kin setup を開いてください(パスワードは会話に書かないでください)</Text>
            )}
            {sv.lines.map(row)}
            {sv.profiles.map(p => (
              <Box key={`p-${p.id}`}>
                <Text color={p.active ? 'green' : undefined}>{`${p.active ? '●' : '○'} ${p.name} ・ ${p.host} ・ ${p.kind === 'prod' ? '本番' : '開発'}`}</Text>
                {!p.active && (
                  <Box>
                    <Text> </Text>
                    <Button key={`use-${p.id}`} label="使う" onPress={() => void useRequest($, p.id)} />
                  </Box>
                )}
              </Box>
            ))}
            <Text dimColor>────────</Text>
          </Box>
        )
    // デスクトップの次の一手は pane の組み立ての中で(v1.1.1 作る・直すのボタンを先頭に置くので)
    const nextEl = wide ? null : nx && (
          <Box flexDirection="column">
            <Text weight="bold">次の一手</Text>
            {[nextItems(nx).slice(0, 4), nextItems(nx).slice(4)].filter(g => g.length).map((g, gi) => (
              <Box key={`next-row-${gi}`}>
                {g.map(it => (
                  <Box key={`next-box-${it.n}`}>
                    {it.on ? (
                      <Button key={`next-${it.n}`} label={`${it.n} ${it.short}`} onPress={() => pressNext($, it.n)} />
                    ) : (
                      <Text key={`next-off-${it.n}`} dimColor>{`${it.n} ${it.short}${NEXT_OFF}`}</Text>
                    )}
                    <Text> </Text>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )
    // v1.1 はじめに(反映先が未選択の時)。押した時の動きは端末とデスクトップで同じ
    const startV = app ? null : await readStart($)
    const startEl = startV && !sv.open && renderStart(el, e.surface, startV, {
      onCreate: () => void startApps($, 'create'),
      onFix: () => void startApps($, 'fix'),
      onConn: () => void (wide ? toggleConn($) : openSetup($)),
      onBack: () => void setStart($, { step: 'menu' }),
      onPickCreateApp: id => void $.prompt.fill({ text: createPrompt(id), mode: 'replace' }).catch(() => undefined),
      onPickFixApp: id => void startPlugins($, id),
      onPickPlugin: name => { if (startV.step === 'fix-plugin') void $.prompt.fill({ text: fixPrompt(startV.appId, name), mode: 'replace' }).catch(() => undefined) },
    })
    // v1.1.1 反映先を選んだ後も「作る」「直す」(端末は反映前のカードだけ)
    const ui = await readPaneUi($)
    const plugNames = fm?.plugins ?? null
    const appActs = {
      onCreate: () => void $.prompt.fill({ text: createPrompt(app), mode: 'replace' }).catch(() => undefined),
      onFix: () => void patchPaneUi($, v => ({ ...v, pick: !v.pick })),
    }
    const nop = () => undefined
    const pickEl = app && ui.pick && renderStart(el, e.surface, { step: 'fix-plugin', appId: app, ...(fm?.appName ? { appName: fm.appName } : {}), plugins: plugNames }, {
      onCreate: nop, onFix: nop, onConn: nop, onPickFixApp: nop,
      onBack: () => void patchPaneUi($, v => ({ ...v, pick: false })),
      onPickCreateApp: id => void $.prompt.fill({ text: createPrompt(id), mode: 'replace' }).catch(() => undefined),
      onPickPlugin: name => void $.prompt.fill({ text: fixPrompt(app, name), mode: 'replace' }).catch(() => undefined),
    })
    const appDeployed = !!pulse?.finishedAt && pulse.appId.split(',')[0] === app
    if (wide) {
      // v1.1 プレビューの pane(Claude Desktop の Agents パネルの作法): 頭(アプリ名+接続先 ▾)→ タイル → 画面 or はじめに → イベント → フォーム → 次の一手 → 結果カード → ▸ 詳細
      // 文字は3段(題・本文・小/灰)だけ。節の見出しは小/灰。Svg は画面のスクショだけ
      const head: HeadView = {
        appId: app || null,
        ...(fm?.appName ? { appName: fm.appName } : band.app?.name ? { appName: band.app.name } : {}),
        kind: band.conn?.kind ?? (mode === 'prod' ? 'prod' : mode === 'dev' ? 'dev' : null),
        last: band.last,
        errors: band.errors,
      }
      const forApp = pulse && pulse.appId.split(',')[0] === app ? pulse : null
      const shots: ScreenShot[] = []
      for (const s of forApp?.shots ?? []) {
        const b64 = await thumbBase64($, s.path)
        if (b64) shots.push({ page: s.page, width: s.width, height: s.height, base64: b64, ...(s.url ? { url: s.url } : {}) })
      }
      const selected: ScreenPage = shots.some(s => s.page === ui.screen) ? ui.screen : (shots[0]?.page ?? ui.screen)
      const running = !!pulse && !pulse.finishedAt
      const errs = forApp?.errors ?? []
      const fold = (fm?.plugins !== undefined || fm?.views !== undefined)
      const resN = Number(/^次の一手 (\d+)$/.exec(pulse?.result?.title ?? '')?.[1] ?? 0)
      // 接続先の一覧(頭の「開発 ▾」と はじめに③)。setup の欄が開いている間はそちらに一覧がある
      const connEl = ui.conn && !sv.open && (
        <Box key="conn" flexDirection="column" gap={GAP_INNER}>
          {sectionHead(el, 'conn-head', '接続先')}
          {sv.profiles.length === 0 && <Text size="caption" dimColor>接続先はまだありません</Text>}
          {sv.profiles.map(p => (
            <Box key={`conn-${p.id}`} flexDirection="row" justifyContent="space-between" alignItems="center">
              <Box flexDirection="column">
                <Text>{`${p.active ? '● ' : ''}${p.name}`}</Text>
                <Text size="caption" dimColor>{`${p.kind === 'prod' ? '本番' : '開発'} · ${p.host}`}</Text>
              </Box>
              {p.active ? <Text size="caption" dimColor>使用中</Text> : <Button key={`conn-use-${p.id}`} label="使う" onPress={() => void useRequest($, p.id)} />}
            </Box>
          ))}
          <Box>
            <Button key="conn-add" label="接続先を追加" onPress={() => void openSetup($)} />
          </Box>
        </Box>
      )
      // v1.1.1 反映先を選んだ後も「作る」「直す」を出す。反映前は画面の節にカード2枚、反映後は次の一手の先頭に小さなボタン2つ
      const deployed = !!forApp?.finishedAt
      const nextWide = app && deployed && !pend && (
        <Box flexDirection="column" gap={GAP_INNER}>
          {sectionHead(el, 'next-head', '次の一手')}
          <Box key="next-row" flexDirection="row" flexWrap="wrap" gap={1}>
            {renderAppButtons(el, plugNames?.length ?? 0, appActs)}
            {nx && nextItems(nx).filter(it => it.on).map(it => (
              <Button key={`next-${it.n}`} label={`${it.n} ${it.short}`} onPress={() => pressNext($, it.n)} />
            ))}
          </Box>
          {pickEl}
        </Box>
      )
      return (
        <Box flexDirection="column" gap={GAP_SECTION}>
          <Box flexDirection="column" gap={GAP_INNER}>
            {renderHead(el, e.surface, head, () => void toggleConn($), ui.conn)}
            {connEl}
          </Box>
          {renderTiles(el, e.surface, head)}
          {running && pulse && renderPulse(el, e.surface, { ...pulse, result: undefined }, err => void $.prompt.fill({ text: fixPromptText(err), mode: 'replace' }).catch(() => undefined))}
          {pendEl}
          {setupEl}
          {startEl}
          {app && renderScreen(el, e.surface, {
            hasDeploy: !!forApp?.finishedAt,
            shots,
            selected,
            errors: errs,
            ...(forApp?.shotNote ? { note: forApp.shotNote } : {}),
          }, {
            onSelect: p => void patchPaneUi($, v => ({ ...v, screen: p })),
            onFix: i => { const er = errs[i]; if (er) void $.prompt.fill({ text: fixPromptText(er), mode: 'replace' }).catch(() => undefined) },
            empty: pickEl || renderAppCards(el, e.surface, plugNames?.length ?? 0, appActs),
          })}
          {forApp?.finishedAt && renderEvents(el, e.surface, forApp.events?.length ? { rows: forApp.events, loads: forApp.loads ?? 0 } : null, {
            showAll: ui.evAll,
            onShowAll: () => void patchPaneUi($, v => ({ ...v, evAll: !v.evAll })),
          })}
          {fm && renderFormMap(el, e.surface, fm, {
            onPick: code => void $.prompt.fill({ text: code, mode: 'insert' }).catch(() => undefined),
            open: ui.form,
            onToggle: () => void patchPaneUi($, v => ({ ...v, form: !v.form })),
            showAll: ui.all,
            onShowAll: () => void patchPaneUi($, v => ({ ...v, all: true })),
          })}
          {!formTop && top.length > 0 && <Box flexDirection="column">{top.map(row)}</Box>}
          {(nextWide || (pulse?.result && resN)) && (
            <Box flexDirection="column" gap={GAP_INNER}>
              {nextWide}
              {/* 次の一手の結果はカード1枚(直前の1回だけ)。URL は Link にだけ */}
              {pulse?.result && resN > 0 && renderResultCard(el, e.surface, resultCard(resN, pulse.result.md))}
            </Box>
          )}
          <Box flexDirection="column" gap={GAP_INNER}>
            <Box>{foldRow(el, 'detail-toggle', '詳細', ui.detail, () => void patchPaneUi($, v => ({ ...v, detail: !v.detail })))}</Box>
            {ui.detail && fold && fm && ([['plugins', '付いているプラグイン', fm.plugins], ['views', '一覧', fm.views]] as const).map(([k, title, names]) =>
              names === undefined ? null : (
                <Box key={`fold-${k}`} flexDirection="column">
                  {names.length > 0
                    ? <Box>{foldRow(el, `fold-${k}`, `${title} ${names.length}`, opened === k, () => void update($, formOpenAtom, v => (v === k ? '' : k)))}</Box>
                    : <Text size="caption" dimColor>{`${title} 0`}</Text>}
                  {opened === k && names.map((nm, i) => <Text key={`fold-${k}-${i}`} size="caption" dimColor>{`  ${nm}`}</Text>)}
                </Box>
              ),
            )}
            {ui.detail && bottom.length > 0 && <Box flexDirection="column">{bottom.map(row)}</Box>}
          </Box>
        </Box>
      )
    }


    return (
      <Box flexDirection="column">
        <Text weight="bold" color={band.conn?.kind === 'prod' ? 'red' : undefined}>{bandText({ ...band, pending: null })}</Text>
        {app && <Text dimColor>{`反映先: アプリ ${app}${mode === 'prod' ? '(本番)' : ''} ・ ${BAND_GUIDE}`}</Text>}
        {app && !appDeployed && !sv.open && !pend && (pickEl || renderAppCards(el, e.surface, plugNames?.length ?? 0, appActs))}
        {pulse && renderPulse(el, e.surface, pulse, err => void $.prompt.fill({ text: fixPromptText(err), mode: 'replace' }).catch(() => undefined))}
        {pendEl}
        {setupEl}
        {startEl}
        {!formTop && topShown.map(row)}
        {!formTop && cut > 0 && <Text dimColor>… 他 {cut} 行</Text>}
        {bottom.length > 0 && <Text dimColor>────────</Text>}
        {bottom.slice(0, bottomRows).map(row)}
        {nextEl}
      </Box>
    )
  })
}
