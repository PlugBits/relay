// kin-loop / kin-probe の JSON を pane の行にする純関数。mod 本体(register.tsx)から使う。
import type { RelayLine } from '../types'

export type Json = Record<string, any>

// 念のため: 認証ヘッダー・パスワードらしき行は pane に出さない(ツール側も出さない二重の守り)
export function redact(text: string): string {
  return text
    .replace(/X-Cybozu-Authorization[^\n]*/gi, 'X-Cybozu-Authorization: [redacted]')
    .replace(/(KINTONE_PASSWORD\s*=)(?!\s*<)[^\n]*/g, '$1[redacted]')
}

// stdout の最後の JSON 行を取る。取れなければ null
export function parseLastJson(stdout: string): Json | null {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || !line.startsWith('{')) continue
    try {
      return JSON.parse(line) as Json
    } catch {
      /* 次の行へ */
    }
  }
  return null
}

// 道具の依存(npm ci)が入っていない時の出力。生のエラーの代わりにこの一文を出す
export const DEPS_MESSAGE = 'プラグイン作成 mod の依存が入っていません。/kin doctor を見てください(端末で npm ci が要ります)'
export const isDepsMissing = (raw: { stdout?: string; stderr?: string }): boolean =>
  /ERR_MODULE_NOT_FOUND|Cannot find package/.test(`${raw.stderr ?? ''}\n${raw.stdout ?? ''}`)

function errorLines(res: Json | null, raw: { stdout: string; stderr: string; code: number | null; timedOut?: number }): RelayLine[] {
  if (!res?.error && isDepsMissing(raw)) return [{ text: '✗ 失敗', tone: 'err' }, { text: DEPS_MESSAGE, tone: 'err' }]
  if (res && res.error) {
    const e = res.error as Json
    const head = e.step ? `✗ 失敗 [${e.step}]` : '✗ 失敗'
    const extra = [e.status ? `HTTP ${e.status}` : '', e.code ? String(e.code) : ''].filter(Boolean).join(' ')
    const msgLines = redact(String(e.message ?? '')).split('\n')
    return [
      { text: extra ? `${head} ${extra}` : head, tone: 'err' },
      ...msgLines.map(text => ({ text, tone: 'err' as const })),
    ]
  }
  const body = redact((raw.stderr.trim() || raw.stdout.trim() || `終了コード ${raw.code}`).slice(0, 1200))
  const lines: RelayLine[] = [{ text: '✗ 失敗', tone: 'err' as const }, ...body.split('\n').map(text => ({ text, tone: 'err' as const }))]
  if (raw.timedOut) lines.push({ text: 'どこまで進んだかは未確認です。もう一度試すか、/kin <appId> で状態を確かめてください', tone: 'dim' as const })
  return lines
}

export function formatApps(res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): RelayLine[] {
  if (!res || !res.ok) return errorLines(res, raw)
  const apps = (res.apps ?? []) as Json[]
  return [
    { text: `アプリ一覧 (${apps.length})  /kin <appId> で対象を選ぶ`, tone: 'head' },
    ...apps.map(a => ({ text: `  ${a.name} ・ ${a.appId}` })),
  ]
}

// フィールドの「形」の短い説明(kin-loop form の lookup / unique / defaultValue / referenceTable)。無ければ空
const clip = (v: unknown, n: number): string => {
  const t = redact(typeof v === 'string' ? v : JSON.stringify(v) ?? '')
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const appRef = (a: Json | undefined): string => (a ? `アプリ ${a.app ?? '?'}${a.code ? `(${a.code})` : ''}` : 'アプリ ?')
export function lookupText(l: Json): string {
  const maps = Array.isArray(l.fieldMappings) ? (l.fieldMappings as Json[]).map(m => `${m.relatedField}→${m.field}`).join(', ') : ''
  return `ルックアップ: 参照先 ${appRef(l.relatedApp)} ・ キー ${l.relatedKeyField ?? '?'}${maps ? ` ・ コピー先 ${clip(maps, 120)}` : ''}`
}
export function refTableText(r: Json): string {
  const c = (r.condition ?? {}) as Json
  const disp = Array.isArray(r.displayFields) && r.displayFields.length ? ` ・ 表示 ${clip(r.displayFields.join(', '), 80)}` : ''
  return `関連レコード: 参照先 ${appRef(r.relatedApp)} ・ 条件 ${c.field ?? '?'}=${c.relatedField ?? '?'}${disp}`
}
function shapeNotes(f: Json): string[] {
  const n: string[] = []
  if (f.unique === true) n.push('重複禁止')
  if (f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '') n.push(`既定値 ${clip(f.defaultValue, 40)}`)
  if (f.lookup && typeof f.lookup === 'object') n.push(lookupText(f.lookup as Json))
  if (f.referenceTable && typeof f.referenceTable === 'object') n.push(refTableText(f.referenceTable as Json))
  return n
}

function fieldLines(fields: Json[], indent: string): RelayLine[] {
  const out: RelayLine[] = []
  for (const f of fields) {
    out.push({ text: `${indent}${f.code} ・ ${f.label} ・ ${f.type}${f.required === true ? ' ・ 必須' : ''}` })
    for (const t of shapeNotes(f)) out.push({ text: `${indent}    ${t}`, tone: 'dim' })
    if (Array.isArray(f.subtable)) out.push(...fieldLines(f.subtable, indent + '    '))
  }
  return out
}

// pane の上段がフォームの文字一覧かを見分ける先頭行(デスクトップでは地図に置き換えて出さない)
export const formHead = (appId: string) => `アプリ ${appId}  フィールド (code ・ label ・ type)`

export function formatForm(appId: string, res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): RelayLine[] {
  if (!res || !res.ok) return errorLines(res, raw)
  const plugins = (res.plugins ?? []) as Json[]
  const c = (res.customize ?? {}) as Json
  const res2 = (label: string, list: unknown): RelayLine[] =>
    Array.isArray(list) && list.length ? [{ text: `  ${label}: ${list.join(', ')}` }] : []
  return [
    { text: formHead(appId), tone: 'head' },
    ...fieldLines((res.fields ?? []) as Json[], '  '),
    ...(Array.isArray(res.views) && res.views.length
      ? [{ text: `一覧 (${res.views.length})`, tone: 'head' as const }, ...(res.views as Json[]).map(v => ({ text: `  ${v.name} ・ ${v.id}` }))]
      : []),
    { text: `付いているプラグイン (${plugins.length})`, tone: 'head' },
    ...plugins.map(p => ({ text: `  ${p.name} ・ ${p.id}` })),
    { text: 'JS / CSS', tone: 'head' },
    ...res2('PC JS', c.desktop?.js),
    ...res2('PC CSS', c.desktop?.css),
    ...res2('モバイル JS', c.mobile?.js),
    ...res2('モバイル CSS', c.mobile?.css),
    ...(!(c.desktop?.js?.length || c.desktop?.css?.length || c.mobile?.js?.length || c.mobile?.css?.length)
      ? [{ text: '  (なし)', tone: 'dim' as const }]
      : []),
  ]
}

export function formatDeploy(name: string, res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): RelayLine[] {
  if (!res || !res.ok) return [{ text: `${name}`, tone: 'head' }, ...errorLines(res, raw)]
  const notes = ((res.steps ?? []) as Json[]).filter(s => s.note).map(s => ({ text: `  ${s.name}: ${s.note}`, tone: 'dim' as const }))
  const apps = Array.isArray(res.apps) && res.apps.length > 1 ? (res.apps as Json[]) : null
  const target = apps ? `アプリ ${apps.map(a => a.appId).join(', ')}` : `アプリ ${res.appId}`
  const perApp: RelayLine[] = apps
    ? apps.map(a => ({ text: `  アプリ ${a.appId}: ${a.ok === false ? `✗ ${redact(String(a.error?.message ?? a.error ?? '失敗')).split('\n')[0]}` : '✓'}`, tone: a.ok === false ? ('err' as const) : ('ok' as const) }))
    : []
  return [{ text: `✓ 反映 ${res.seconds} 秒  (${name} → ${target})`, tone: 'ok' }, ...perApp, ...notes]
}

// 複数アプリへの反映の結果(道具の返り値)。apps は kin-loop deploy の apps、probes は各アプリの画面チェックの文
export function mdDeployMulti(name: string, dep: Json, probeMds: { appId: string; md: string }[]): string {
  const apps = (Array.isArray(dep.apps) ? dep.apps : []) as Json[]
  const ids = apps.map(a => a.appId).join(', ')
  return redact(
    [
      `${name} をアプリ ${ids} に反映${dep.ok ? 'しました' : 'しましたが失敗したアプリがあります'}(${dep.seconds ?? '?'}秒・pluginId ${dep.pluginId ?? '?'}・プラグイン本体の更新は1回)`,
      ...apps.map(a => `- アプリ ${a.appId}: ${a.ok === false ? `NG ${short(String(a.error?.message ?? a.error ?? '理由不明').split('\n')[0] ?? '', 160)}` : 'OK'}`),
      ...(dep.build && typeof dep.build === 'object' ? [`ビルド: 済(${(dep.build as Json).seconds ?? '?'}秒)→ ${String((dep.build as Json).dir ?? '')} を包みました`] : []),
      configResult(dep),
      ...probeMds.map(p => p.md),
    ].join('\n\n'),
  )
}

const PAGE_LABEL: Record<string, string> = { config: '設定画面', detail: 'レコード詳細', index: '一覧', actions: '手順' }

const errStr = (e: unknown): string => (typeof e === 'string' ? e : typeof (e as Json | null)?.message === 'string' ? String((e as Json).message) : e ? JSON.stringify(e) : '')
const nm = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// events を「発火 N・登録 M」で(重複発火か登録の重複か読み込み回数かを分ける)。loads は読み込み回数。形が古ければ空
export function eventCounts(p: Json): string {
  const ev = (Array.isArray(p.events) ? p.events : []) as Json[]
  if (!ev.length || !ev.some(e => e.handlers !== undefined) && p.loads === undefined) return ''
  const body = ev.map(e => `${e.type} 発火${nm(e.count)}${e.handlers !== undefined ? `・登録${nm(e.handlers)}` : ''}`).join(', ')
  return `${p.loads !== undefined ? `読み込み${nm(p.loads)}回 ・ ` : ''}${body}`
}

// 手順の結果(kin-probe --actions の actions)。1手順 1 行
function actionText(a: Json): string {
  const kind = String(a.kind ?? '?')
  return `手順${a.i ?? '?'} ${kind} ${a.ok === false ? '✗' : '✓'}${a.ms !== undefined ? ` ${nm(a.ms)}ms` : ''}${a.recordId ? ` #${a.recordId}` : ''}${a.ok === false && a.error ? ` ${clip(errStr(a.error), 160)}` : ''}`
}
const screenParts = (sc: Json): { dialog: string; text: string; buttons: string; labels: string } => ({
  dialog: typeof sc.dialog === 'string' ? clip(sc.dialog.replace(/\s+/g, ' '), 300) : '',
  text: typeof sc.text === 'string' ? clip(sc.text.replace(/\s+/g, ' '), 300) : '',
  buttons: Array.isArray(sc.buttons) ? (sc.buttons as unknown[]).slice(0, 15).join(' / ') : '',
  labels: Array.isArray(sc.labels) ? (sc.labels as unknown[]).slice(0, 20).join(' / ') : '',
})
const openedText = (o: Json): string => `開いた画面: ${o.page ?? '?'}${o.recordId ? ` レコード#${o.recordId}` : ''}${o.url ? ` ${clip(String(o.url), 160)}` : ''}`

// 画面チェックの省略(chromium が無い・ログイン不可)。失敗ではない: 反映は済んでいる
export const SKIP_REASON: Record<string, string> = { 'no-browser': 'ブラウザが無い', login: 'ログイン不可' }
export const skippedText = (res: Json): string =>
  redact(`画面チェックは省略(${String(res.reason ?? SKIP_REASON[String(res.skipCode)] ?? '理由不明')}・反映は済)`)

export function formatProbe(res: Json | null, raw: { stdout: string; stderr: string; code: number | null; timedOut?: number }): RelayLine[] {
  if (res?.skipped) return [{ text: skippedText(res), tone: 'dim' }]
  if (!res || (!res.pages && !res.actions)) return [{ text: '画面チェック', tone: 'head' }, ...errorLines(res, raw)]
  const out: RelayLine[] = [{ text: `画面チェック ${res.seconds} 秒`, tone: 'head' }]
  for (const p of (res.pages ?? []) as Json[]) {
    const label = PAGE_LABEL[p.name] ?? p.name
    if (p.skipped) {
      out.push({ text: `  ${label}: スキップ(レコードなし)`, tone: 'dim' })
      continue
    }
    const errs: RelayLine[] = [
      ...(p.pageErrors ?? []).map((e: Json) => ({ text: `    未捕捉例外: ${e.message}${e.at ? ` (${e.at})` : ''}`, tone: 'err' as const })),
      ...(p.consoleErrors ?? []).map((e: Json) => ({ text: `    console.error: ${e.text}${e.location ? ` (${e.location})` : ''}`, tone: 'err' as const })),
      ...(p.failedRequests ?? []).map((e: Json) => ({ text: `    ${e.status} ${e.url}`, tone: 'err' as const })),
    ]
    out.push({ text: `  ${label}${p.recordId ? ` #${p.recordId}` : ''}${errs.length ? '' : ': エラーなし'}`, tone: errs.length ? undefined : 'ok' })
    out.push(...errs)
    const ec = eventCounts(p)
    if (ec) out.push({ text: `    events: ${ec}`, tone: 'dim' })
    if (p.screen && typeof p.screen === 'object') {
      const sp = screenParts(p.screen as Json)
      if (sp.buttons) out.push({ text: `    ボタン: ${sp.buttons}`, tone: 'dim' })
      if (sp.labels) out.push({ text: `    項目名: ${sp.labels}`, tone: 'dim' })
    }
    const order = (p.eventOrder ?? []) as string[]
    if (order.length) {
      const shown = order.slice(0, 12).join(' → ')
      out.push({ text: `    kintone.events: ${shown}${order.length > 12 ? ` …(+${order.length - 12})` : ''}`, tone: 'dim' })
    }
  }
  const acts = (Array.isArray(res.actions) ? res.actions : []) as Json[]
  if (acts.length) {
    out.push({ text: '手順', tone: 'head' })
    for (const a of acts) out.push({ text: `  ${actionText(a)}`, tone: a.ok === false ? 'err' : undefined })
    for (const a of acts) if (a.text) out.push({ text: `    手順${a.i}の画面: ${clip(String(a.text).replace(/\s+/g, ' '), 200)}`, tone: 'dim' })
  }
  if (res.opened && typeof res.opened === 'object') out.push({ text: openedText(res.opened as Json) })
  if (res.screen && typeof res.screen === 'object') {
    const sp = screenParts(res.screen as Json)
    out.push({ text: '最後の画面', tone: 'head' })
    if (sp.dialog) out.push({ text: `  ダイアログ: ${sp.dialog}` })
    else if (sp.text) out.push({ text: `  本文: ${sp.text}`, tone: 'dim' })
    if (sp.buttons) out.push({ text: `  ボタン: ${sp.buttons}` })
    if (sp.labels) out.push({ text: `  項目名: ${sp.labels}`, tone: 'dim' })
  }
  if (typeof res.sheetError === 'string' && res.sheetError) out.push({ text: `縮小1枚は作れませんでした(${redact(res.sheetError)})`, tone: 'dim' })
  return out
}

// 会話に渡す 1 行(kin-probe の summary は「mod からの報告: …」で始まる)
export function reportFromProbe(res: Json | null): string | null {
  if (res?.skipped) return redact(`mod からの報告: ${skippedText(res)}`).slice(0, 300)
  if (!res || typeof res.summary !== 'string') return null
  return redact(res.summary)
}

export function reportFromDeployFailure(name: string, res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): string {
  const e = res?.error as Json | undefined
  const msg = e ? `[${e.step ?? '?'}] ${String(e.message ?? '').split('\n')[0]}` : (raw.stderr.trim() || raw.stdout.trim() || `終了コード ${raw.code}`).split('\n')[0]
  return redact(`mod からの報告: ${name} の反映に失敗 ${msg}`).slice(0, 300)
}

// ---- undo(kin-loop undo の結果) ----

const PART_LABEL: Record<string, string> = { 'app-plugin': 'アプリのプラグイン', 'plugin-version': 'プラグインの版', deploy: 'アプリ設定の反映' }

export function formatUndo(res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): RelayLine[] {
  if (!res || !res.parts) return [{ text: '元に戻す', tone: 'head' }, ...errorLines(res, raw)]
  const parts = res.parts as Json[]
  const head: RelayLine = res.ok
    ? { text: `${res.restored ? '✓' : '・'} 元に戻す アプリ ${res.appId}${(res.cannot ?? []).length ? '(戻せない物あり)' : ''}`, tone: res.restored ? 'ok' : 'head' }
    : { text: `✗ 元に戻す アプリ ${res.appId}(失敗あり)`, tone: 'err' }
  return [
    head,
    ...parts.map(p => ({
      text: `  ${PART_LABEL[p.name] ?? p.name}: ${redact(String(p.message ?? ''))}`,
      tone: p.status === 'failed' ? ('err' as const) : p.status === 'cannot' ? ('dim' as const) : undefined,
    })),
  ]
}

// ---- ② pane の内容を文字でも会話へ: 短い Markdown(表・全体 20 行以内) ----

export const DIGEST_MAX = 20
export const DIGEST_CUT = '…(pane に全文)'

const cell = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
const short = (v: string, n = 160): string => (v.length > n ? `${v.slice(0, n - 1)}…` : v)

// head と tail は必ず残し、body が溢れたら途中で切って最後に「…(pane に全文)」を足す。全体は max 行
export function clipDigest(head: string[], body: string[], tail: string[] = [], max = DIGEST_MAX): string {
  const room = Math.max(0, max - head.length - tail.length)
  const cut = body.length > room
  const shown = cut ? body.slice(0, Math.max(0, room - 1)) : body
  return redact([...head, ...shown, ...(cut ? [DIGEST_CUT] : []), ...tail].join('\n'))
}

function digestError(title: string, res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): string {
  const lines = errorLines(res, raw).map(l => l.text)
  return clipDigest([`mod からの報告: ${title}`], lines.map(l => short(l)), [], 6)
}

export function digestApps(res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): string {
  if (!res || !res.ok) return digestError('kintone に接続できません', res, raw)
  const apps = (res.apps ?? []) as Json[]
  return clipDigest(
    [`mod からの報告: kintone アプリ一覧 (${apps.length} 件)`, '| アプリ | 番号 |', '|---|---|'],
    apps.map(a => `| ${cell(a.name)} | ${cell(a.appId)} |`),
  )
}

export function digestForm(appId: string, res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): string {
  if (!res || !res.ok) return digestError(`アプリ ${appId} を読めません`, res, raw)
  const rows: string[] = []
  const walk = (fields: Json[], mark: string) => {
    for (const f of fields) {
      const notes = shapeNotes(f)
      rows.push(`| ${mark}${cell(f.code)} | ${cell(f.label)} | ${cell(short(`${f.type}${notes.length ? ` ・ ${notes.join(' ・ ')}` : ''}`, 220))} |`)
      if (Array.isArray(f.subtable)) walk(f.subtable, '↳ ')
    }
  }
  walk((res.fields ?? []) as Json[], '')
  const plugins = (res.plugins ?? []) as Json[]
  const c = (res.customize ?? {}) as Json
  const res2 = [
    ['PC JS', c.desktop?.js],
    ['PC CSS', c.desktop?.css],
    ['モバイル JS', c.mobile?.js],
    ['モバイル CSS', c.mobile?.css],
  ]
    .filter(([, list]) => Array.isArray(list) && (list as unknown[]).length)
    .map(([label, list]) => `${label}: ${(list as unknown[]).join(', ')}`)
  return clipDigest(
    [`mod からの報告: アプリ ${appId} のフォーム${res.mode === 'prod' ? '(本番)' : ''}`, '| code | label | type |', '|---|---|---|'],
    rows,
    [
      // 空行で表を閉じる(無いと一覧・プラグインの行が表の行として描かれる)
      '',
      ...(Array.isArray(res.views) && res.views.length
        ? [short(`一覧 (${res.views.length}): ${(res.views as Json[]).map(v => `${v.name} (${v.id})`).join(', ')}`, 300)]
        : []),
      short(`プラグイン (${plugins.length}): ${plugins.length ? plugins.map(p => `${p.name} (${p.id})`).join(', ') : 'なし'}`, 200),
      short(`JS/CSS: ${res2.length ? res2.join(' / ') : 'なし'}`, 200),
    ],
  )
}

export function digestProbe(appId: string, res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): string {
  if (res?.skipped) return clipDigest([`mod からの報告: 画面チェック アプリ ${appId}`], [skippedText(res)])
  if (!res || (!res.pages && !res.actions)) return digestError('画面チェックできません', res, raw)
  const rows: string[] = []
  for (const p of (res.pages ?? []) as Json[]) {
    const label = PAGE_LABEL[p.name] ?? p.name
    if (p.skipped) {
      rows.push(`| ${cell(label)} | スキップ(レコードなし) |`)
      continue
    }
    const errs: string[] = [
      ...(p.pageErrors ?? []).map((e: Json) => `未捕捉例外 ${e.message}${e.at ? ` (${e.at})` : ''}`),
      ...(p.consoleErrors ?? []).map((e: Json) => `console.error ${e.text}`),
      ...(p.failedRequests ?? []).map((e: Json) => `${e.status} ${e.url}`),
    ]
    const shown = errs.slice(0, 2).map(e => short(e, 120)).join('; ')
    rows.push(`| ${cell(label)} | ${errs.length ? cell(`${shown}${errs.length > 2 ? ` ほか ${errs.length - 2} 件` : ''}`) : 'エラーなし'} |`)
    const order = (p.eventOrder ?? []) as string[]
    if (order.length) rows.push(`| ${cell(label)} events | ${cell(order.slice(0, 8).join(' → ') + (order.length > 8 ? ` …(+${order.length - 8})` : ''))} |`)
    const ec = eventCounts(p)
    if (ec) rows.push(`| ${cell(label)} 発火/登録 | ${cell(short(ec, 200))} |`)
    if (p.recordId) rows.push(`| ${cell(label)} レコード | #${cell(p.recordId)} |`)
    if (p.screen && typeof p.screen === 'object') {
      const sp = screenParts(p.screen as Json)
      if (sp.buttons) rows.push(`| ${cell(label)} ボタン | ${cell(sp.buttons)} |`)
      if (sp.labels) rows.push(`| ${cell(label)} 項目名 | ${cell(sp.labels)} |`)
    }
  }
  const acts = (Array.isArray(res.actions) ? res.actions : []) as Json[]
  for (const a of acts) {
    rows.push(`| 手順${cell(a.i)} ${cell(a.kind)} | ${a.ok === false ? `NG ${cell(short(errStr(a.error), 120))}` : a.skipped ? 'スキップ' : 'OK'}${a.recordId ? ` #${cell(a.recordId)}` : ''}${a.text ? ` ・ ${cell(short(String(a.text), 100))}` : ''} |`)
  }
  if (res.opened && typeof res.opened === 'object') rows.push(`| 開いた画面 | ${cell(short(openedText(res.opened as Json).replace('開いた画面: ', ''), 200))} |`)
  if (res.screen && typeof res.screen === 'object') {
    const sp = screenParts(res.screen as Json)
    if (sp.dialog) rows.push(`| 画面 ダイアログ | ${cell(sp.dialog)} |`)
    else if (sp.text) rows.push(`| 画面 本文 | ${cell(sp.text)} |`)
    if (sp.buttons) rows.push(`| 画面 ボタン | ${cell(sp.buttons)} |`)
    if (sp.labels) rows.push(`| 画面 項目名 | ${cell(sp.labels)} |`)
  }
  return clipDigest([`mod からの報告: 画面チェック アプリ ${appId} (${res.seconds} 秒)`, '| 画面 | 結果 |', '|---|---|'], rows, [], acts.length || res.screen ? 34 : DIGEST_MAX)
}

export function digestUndo(res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): string {
  if (!res || !res.parts) return digestError('元に戻せませんでした', res, raw)
  return clipDigest(
    [`mod からの報告: アプリ ${res.appId} を元に戻す`, '| 部分 | 結果 |', '|---|---|'],
    (res.parts as Json[]).map(p => `| ${cell(PART_LABEL[p.name] ?? p.name)} | ${cell(short(String(p.message ?? '')))} |`),
  )
}

export function reportFromUndo(res: Json | null, raw: { stdout: string; stderr: string; code: number | null }): string {
  if (!res || !res.parts) return redact(`mod からの報告: 元に戻せませんでした ${String(res?.error?.message ?? raw.stderr ?? '').split('\n')[0]}`).slice(0, 300)
  const cannot = (res.cannot ?? []) as string[]
  return redact(
    `mod からの報告: アプリ ${res.appId} を元に戻す ${res.restored ? '(前の版を戻して反映)' : '(戻した物なし)'}${
      cannot.length ? ` 戻せません: ${cannot.map(n => PART_LABEL[n] ?? n).join('・')}` : ''
    }${res.ok ? '' : ' 失敗あり'}`,
  ).slice(0, 300)
}

// ---- 道具(kin_*)向け: モデルに返す値。パスワード・ppk の中身は返さない ----

type Raw = { stdout: string; stderr: string; code: number | null; timedOut?: number }

const SECRET_KEY = /pass(word)?|secret|token|authorization|private|ppk|cookie|credential/i

// 秘密らしい名前のキーを落として、文字列は redact してから JSON にする
export function safeJson(v: unknown): string {
  return redact(
    JSON.stringify(v, (k, val) => (k && SECRET_KEY.test(k) && !/^(hasPpk)$/.test(k) ? undefined : val)) ?? 'null',
  )
}

export function toolError(res: Json | null, raw: Raw): string {
  if (!res?.error && isDepsMissing(raw)) return safeJson({ ok: false, error: { code: 'deps_missing', message: DEPS_MESSAGE } })
  const e = (res?.error ?? {}) as Json
  const message = redact(String(e.message ?? (raw.stderr.trim() || raw.stdout.trim() || `終了コード ${raw.code}`))).slice(0, 1200)
  return safeJson({ ok: false, error: { code: raw.timedOut ? 'timeout' : e.code, step: e.step, status: e.status, message } })
}

// `/a/b/../c` を畳む(絶対パスのみ)。.. が根を越えたら null
function normalizeAbs(p: string): string | null {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  return '/' + out.join('/')
}

// 道具に渡されたパスを cwd 基準で解決し、root の下(root そのものは除く)か確かめる。外・秘密置き場なら null
export function resolveUnder(cwd: string, input: string, rootRel: string = ''): string | null {
  if (typeof input !== 'string' || input === '' || /[\0\n,]/.test(input) || input.startsWith('-')) return null
  const base = normalizeAbs(cwd)
  if (!base) return null
  const abs = normalizeAbs(input.startsWith('/') ? input : `${base}/${input}`)
  const root = normalizeAbs(rootRel ? `${base}/${rootRel}` : base)
  if (!abs || !root) return null
  if (!abs.startsWith(root === '/' ? '/' : root + '/')) return null
  const rel = abs.slice(root.length + 1)
  if (/(^|\/)(\.keys|node_modules|\.git)(\/|$)/.test(rel) || /\.ppk$|(^|\/)kintone\.env$/.test(rel)) return null
  return abs
}

export const isAppId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,10}$/.test(v)

const cellT = (v: unknown) => redact(String(v ?? '')).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 80)

// 試験で入れたと分かる名前(外す公式 API は無いので、印を付けて人に任せる)
const TEST_NAME = /\[relay\]|テスト|試験|サンプル|\btest\b|\bsample\b/i

export function mdPlugins(appId: string, res: Json): string {
  const plugins = (res.plugins ?? []) as Json[]
  const c = (res.customize ?? {}) as Json
  const list = (l: unknown) => (Array.isArray(l) && l.length ? l.join(', ') : '(なし)')
  return [
    `アプリ ${appId} のプラグイン (${plugins.length})`,
    '| 名前 | id | 有効 | メモ |',
    '|---|---|---|---|',
    ...plugins.map(p => `| ${cellT(p.name)} | ${cellT(p.id)} | ${p.enabled === false ? 'いいえ' : 'はい'} | ${TEST_NAME.test(String(p.name ?? '')) ? '試験用(画面で外せます)' : ''} |`),
    `PC JS: ${list(c.desktop?.js)} / PC CSS: ${list(c.desktop?.css)}`,
    `モバイル JS: ${list(c.mobile?.js)} / モバイル CSS: ${list(c.mobile?.css)}`,
  ].join('\n')
}

export function mdBackups(appId: string, res: Json): string {
  const b = (res.backups ?? []) as Json[]
  return [
    `アプリ ${appId} の控え (${b.length})`,
    '| 時刻 | プラグイン | 版 | 戻し済み |',
    '|---|---|---|---|',
    ...b.slice(0, 20).map(x => `| ${cellT(x.createdAt)} | ${cellT(x.pluginName ?? x.pluginId)} | ${cellT(x.version)} | ${x.undone ? 'はい' : ''} |`),
    ...(b.length > 20 ? [`…(他 ${b.length - 20} 件)`] : []),
  ].join('\n')
}

export function pickStatus(res: Json, profile?: string): string {
  const keys = ['mode', 'host', 'prodApps', 'relayVersion', 'backups']
  return safeJson({ ...(profile ? { profile } : {}), ...Object.fromEntries(keys.filter(k => k in res).map(k => [k, res[k]])) })
}

export function mdDeployResult(name: string, appId: string, dep: Json, probeMd: string | null): string {
  return [
    `${name} をアプリ ${appId} に反映しました(${dep.seconds ?? '?'}秒・pluginId ${dep.pluginId ?? '?'})`,
    ...(dep.build && typeof dep.build === 'object' ? [`ビルド: 済(${(dep.build as Json).seconds ?? '?'}秒)→ ${String((dep.build as Json).dir ?? '')} を包みました`] : []),
    configResult(dep),
    probeMd ?? '画面チェックは出来ませんでした',
  ].join('\n\n')
}

// 設定値 API の段(relay.config.json を渡した時だけある)を1行に
function configResult(dep: Json): string {
  const steps = Array.isArray(dep.steps) ? (dep.steps as Json[]) : []
  const st = steps.find(x => x && x.name === 'config')
  if (!st) return '設定値: 入れていません(plugins/<name>/relay.config.json が無い)'
  if (st.unchanged) return '設定値: relay.config.json が前回と同じなので送っていません(設定画面の値をそのまま使います。変えたい時は relay.config.json を直す)'
  // 送らなかった段(設定値が無い・読めない等)は ok でも「入れました」と言わない
  if (st.skipped) return `設定値: 送っていません — ${String(st.note ?? '理由不明')}`
  if (st.ok) return '設定値: relay.config.json の値を設定値 API で入れました'
  return `設定値: 入っていません — ${String(st.note ?? st.error ?? '理由不明')}`
}

// ---- v0.4 接続設定(kin-profile / kin-doctor)。パスワードは受け取らない・返さない ----

export const SETUP_NEEDED = '/kin setup で接続先を入れてください'

export const isProdKind = (k: unknown): boolean => k === 'prod' || k === '本番'
const kindLabel = (k: unknown): string => (isProdKind(k) ? '本番' : '開発')
const appsText = (v: unknown): string => (Array.isArray(v) && v.length ? v.join(', ') : 'なし')

// 入力欄の「アプリ番号」を数字の配列に。数字以外が混じったら null
export function parseAppNumbers(text: string): string[] | null {
  const parts = text.split(/[\s,、]+/).filter(Boolean)
  return parts.every(p => /^\d{1,10}$/.test(p)) ? parts : null
}

export function formatProfiles(res: Json | null, raw: Raw): RelayLine[] {
  if (!res || !res.ok) return errorLines(res, raw)
  const items = (res.items ?? []) as Json[]
  if (items.length === 0) return [{ text: `接続先が未設定です。${SETUP_NEEDED}`, tone: 'dim' }]
  return [
    { text: `接続先 (${items.length})  /kin use <id> で切り替え`, tone: 'head' },
    ...items.map(it => ({
      text: `  ${it.active ? '●' : '○'} ${redact(String(it.name ?? it.id))} (${redact(String(it.id))}) ・ ${redact(String(it.host ?? ''))} ・ ${kindLabel(it.kind)}${
        it.passwordSet === false ? ' ・ パスワード未設定' : ''
      }`,
      tone: it.active ? ('ok' as const) : undefined,
    })),
  ]
}

export function mdProfiles(res: Json): string {
  const items = (res.items ?? []) as Json[]
  return clipDigest(
    [`mod からの報告: 接続先の一覧 (${items.length} 件)`, '| 名前 | id | ホスト | 種別 | 今 |', '|---|---|---|---|---|'],
    items.map(it => `| ${cell(it.name)} | ${cell(it.id)} | ${cell(it.host)} | ${kindLabel(it.kind)} | ${it.active ? '使用中' : ''} |`),
  )
}

export function formatConnStatus(res: Json | null, raw: Raw): RelayLine[] {
  if (res?.error?.code === 'missing') return [{ text: SETUP_NEEDED, tone: 'head' }]
  if (!res || !res.ok) return errorLines(res, raw)
  return [
    { text: `今の接続先: ${redact(String(res.name ?? res.active ?? '?'))}`, tone: 'head' },
    { text: `  ホスト: ${redact(String(res.host ?? '?'))}` },
    { text: `  モード: ${res.mode === 'prod' ? '本番' : '開発'}` },
    { text: `  本番に反映してよいアプリ: ${appsText(res.prodApps)}` },
    { text: `  登録している接続先: ${res.profiles ?? '?'}`, tone: 'dim' },
    ...(res.relayVersion ? [{ text: `  mod の版: ${redact(String(res.relayVersion))}`, tone: 'dim' as const }] : []),
  ]
}

export function mdConnStatus(res: Json | null, raw: Raw): string {
  if (res?.error?.code === 'missing') return `mod からの報告: ${SETUP_NEEDED}`
  if (!res || !res.ok) return digestError('接続先を読めません', res, raw)
  return clipDigest(
    [`mod からの報告: 今の接続先 ${cell(res.name ?? res.active)}`, '| 項目 | 値 |', '|---|---|'],
    [`| ホスト | ${cell(res.host)} |`, `| モード | ${res.mode === 'prod' ? '本番' : '開発'} |`, `| 本番に反映してよいアプリ | ${cell(appsText(res.prodApps))} |`, ...(res.relayVersion ? [`| mod の版 | ${cell(res.relayVersion)} |`] : [])],
  )
}

export function formatDoctor(res: Json | null, raw: Raw): RelayLine[] {
  if (!res || !Array.isArray(res.checks)) return [{ text: '診断 (doctor)', tone: 'head' }, ...errorLines(res, raw)]
  const checks = res.checks as Json[]
  const out: RelayLine[] = [{ text: `診断 (doctor) ${res.ok ? '✓ すべて通りました' : '✗ 直すところがあります'}`, tone: res.ok ? 'ok' : 'head' }]
  for (const c of checks) {
    out.push({ text: `  ${c.ok ? '✓' : '✗'} ${redact(String(c.name))}: ${redact(String(c.message ?? ''))}`, tone: c.ok ? 'ok' : 'err' })
    if (!c.ok && c.fix) for (const l of redact(String(c.fix)).split('\n')) out.push({ text: `      → ${l}`, tone: 'dim' })
  }
  return out
}

export function mdDoctor(res: Json | null, raw: Raw): string {
  if (!res || !Array.isArray(res.checks)) return digestError('診断できません', res, raw)
  const rows = (res.checks as Json[]).map(c => `| ${cell(c.name)} | ${c.ok ? 'OK' : 'NG'} ${cell(short(String(c.message ?? ''), 100))}${c.ok || !c.fix ? '' : ` → ${cell(short(String(c.fix), 140))}`} |`)
  return clipDigest([`mod からの報告: 診断 ${res.ok ? '(すべて OK)' : '(直すところあり)'}`, '| 項目 | 結果 |', '|---|---|'], rows)
}

// 保存の結果。pw が文字として混じっていたら伏せる(CLI は返さない約束だが二重の守り)
export function scrub(text: string, pw: string): string {
  return pw.length >= 3 ? text.split(pw).join('[redacted]') : text
}

export function formatSaveResult(res: Json | null, raw: Raw, pw: string): RelayLine[] {
  const lines = (() => {
    if (!res || !res.ok) return errorLines(res, raw)
    const st = (res.check?.status ?? {}) as Json
    const probe = (res.check?.probe ?? {}) as Json
    const out: RelayLine[] = [{ text: `✓ 設定済み(${String(res.id ?? '')})`, tone: 'ok' }]
    if (st.host) out.push({ text: `  接続先: ${st.host}` })
    if (st.mode) out.push({ text: `  モード: ${st.mode === 'prod' ? '本番' : '開発'}` })
    if (st.mode === 'prod') out.push({ text: `  本番に反映してよいアプリ: ${appsText(st.prodApps)}` })
    if (st.ok === false && st.error) out.push({ text: `  ✗ ${typeof st.error === 'string' ? st.error : (st.error.message ?? '')}`, tone: 'err' })
    if (probe.code !== undefined || probe.message) {
      const bad = /^(401|403|404|5\d\d)$/.test(String(probe.code)) || /^(4|5)\d\d$/.test(String(probe.code))
      out.push({ text: `  接続確認: ${probe.code ?? ''} ${probe.message ?? ''}`.trimEnd(), tone: bad ? 'err' : 'dim' })
    }
    if (res.hint) for (const l of String(res.hint).split('\n')) out.push({ text: `  ${l}`, tone: 'dim' })
    if (res.active === false) out.push({ text: '保存だけでは接続先は変わりません。「使う」を押してください', tone: 'head' })
    return out
  })()
  return lines.map(l => ({ ...l, text: scrub(redact(l.text), pw) }))
}

// ---- 反映の後の「次の一手」。番号は固定(出さない項目は飛ばす)。認証情報・設定値は持たない ----

export type NextState = {
  appId: string
  name: string
  dir: string
  pluginId: string
  origin: string
  mode: 'dev' | 'prod'
  shot: boolean
  rec?: string
  // kin-records list の件数(試験データの記録)。0 や無しなら 8 は出さない
  testRecords?: number
}

// on: 今選べるか。番号は固定で、選べない物は「(今は無し)」と薄く出す
export type NextItem = { n: number; label: string; short: string; on: boolean }

export const NEXT_DIGITS = '１２３４５６７８'
export const NEXT_MAX = 8
// 全角数字も受ける。1〜8 でなければ 0
export function parseNextNumber(text: string): number {
  const t = text.trim()
  if (t.length !== 1) return 0
  const i = NEXT_DIGITS.indexOf(t)
  const n = i >= 0 ? i + 1 : Number(t)
  return Number.isInteger(n) && n >= 1 && n <= NEXT_MAX ? n : 0
}

export const NEXT_OFF = '(今は無し)'

// 1〜8 を必ずこの順で全部返す(番号は動かさない)。on=false が「今は無し」
export function nextItems(s: NextState): NextItem[] {
  return nextAll(s)
}
export function nextAll(s: NextState): NextItem[] {
  const all: NextItem[] = [
    { n: 1, label: '画面で見る', short: '画面で見る', on: true },
    { n: 2, label: '設定を変える', short: '設定を変える', on: true },
    { n: 3, label: '見た目を見る(縮小1枚)', short: '見た目を見る', on: !s.shot },
    { n: 4, label: 'もう1本作る', short: 'もう1本作る', on: true },
    { n: 5, label: '戻す', short: '戻す', on: true },
    { n: 6, label: '本番に入れる', short: '本番に入れる', on: s.mode === 'dev' },
    { n: 7, label: '終わる(配布用の zip を作る)', short: '終わる', on: true },
    { n: 8, label: '試験データを片付ける', short: '試験データを片付ける', on: (s.testRecords ?? 0) > 0 },
  ]
  return all
}

// 選べない物も名前は残す(番号だけだと何か分からない)
const itemText = (i: NextItem): string => (i.on ? `${i.n} ${i.label}` : `${i.n} ${i.short}${NEXT_OFF}`)

// ユーザーの画面に出す一覧(ui.log と道具の結果・digest で同じ形)
export function mdNextList(s: NextState): string {
  const lines = nextItems(s).map(itemText)
  return redact([`次の一手(${s.name} → アプリ ${s.appId}):`, ...lines, '番号か言葉で返してください'].join('\n'))
}

// 会話(ui.log)用の3行: 見出し・番号の並び・案内(ui.log は1行ずつ並ぶので、行を増やさない)
export function logNextList(s: NextState): string {
  const items = nextItems(s).map(itemText).join(' ・ ')
  return redact([`次の一手(${s.name} → アプリ ${s.appId})`, items, '番号か言葉で返してください'].join('\n'))
}

// モデル向けの添え書き付き(道具の結果・次のプロンプトの context)
export function mdNextForModel(s: NextState): string {
  return redact(
    [
      mdNextList(s),
      '',
      'この一覧はユーザーの画面に出してある。自分から番号の処理をしない。ユーザーが言葉で返したらそれに沿う(番号だけで返された時は mod が処理する)。番号の意味は上の一覧のとおり。',
    ].join('\n'),
  )
}

export function mdNextUrls(s: NextState): string {
  if (!s.origin) return '1 画面で見る: 接続先のホストが分かりませんでした。kintone でアプリを開いてください'
  const lines = [`一覧: ${s.origin}/k/${s.appId}/`]
  if (s.rec) lines.push(`レコード詳細: ${s.origin}/k/${s.appId}/show#record=${s.rec}`)
  return redact(['1 画面で見る', ...lines].join('\n'))
}

export function mdNextConfig(s: NextState): string {
  const lines = ['2 設定を変える']
  if (s.origin) lines.push(`設定画面: ${s.origin}/k/admin/app/${s.appId}/plugin/config?pluginId=${s.pluginId}`)
  lines.push('画面で保存したら、アプリの設定の「アプリを更新」を押すか、Claude に「反映して」と伝えてください(更新するまで本体には出ません)')
  lines.push(`設定値だけ直すなら plugins/${s.name}/relay.config.json を書いて反映し直します。Claude に「設定値だけ変えて」と言葉で伝えてください`)
  return redact(lines.join('\n'))
}

export const NEXT_CREATE = '4 もう1本作る\n作りたい物を言葉で送ってください'

export function mdNextShot(path: string | null, err: string): string {
  return redact(path ? `3 見た目を見る\n縮小1枚: ${path}\n(このプラグインでは1回だけです)` : `3 見た目を見る\n縮小1枚は作れませんでした${err ? `(${err})` : ''}`)
}

export function mdNextProd(items: { id: string; name: string; host: string; kind: string }[], appId: string): string {
  const prod = items.filter(i => isProdKind(i.kind))
  if (prod.length === 0) return '6 本番に入れる\n本番の接続先がまだありません。/kin setup で本番の接続先を入れてください(種別は本番・反映してよいアプリ番号も入れます)'
  return redact(
    [
      '6 本番に入れる',
      `本番の接続先: ${prod.map(i => `${i.name}(${i.id}・${i.host})`).join(' / ')}`,
      `手順: /kin use ${prod[0]?.id ?? '<id>'} → /kin ${appId}(本番側のアプリ番号に置き換える) → 保存して反映(本番は確認待ちで止まります。「反映」か /kin ok)`,
    ].join('\n'),
  )
}

export function mdNextPack(j: Json | null): string {
  if (!j?.ok) return redact(`7 終わる\nzip を作れませんでした: ${String(j?.error?.message ?? '理由不明').split('\n')[0]}`)
  return redact(`7 終わる\n配布用の zip: ${j.file}(${j.bytes} バイト・version ${j.version ?? '?'})`)
}

// ---- v0.8 ビルド段(kin-build)・フォーム変更(form-change)・試験データ(kin-records) ----

const lastLines = (v: unknown, n: number, maxChars: number): string => {
  const text = Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : ''
  const t = text.split('\n').filter(l => l.trim() !== '').slice(-n).join('\n')
  return redact(t.length > maxChars ? t.slice(-maxChars) : t)
}

// kin-build の失敗を、反映の失敗と同じ形(error: {code, step, message})にする。末尾 20 行を message に載せる
export function buildFailure(res: Json | null, raw: Raw): Json {
  if (raw.timedOut) return { ok: false, error: { code: 'build_failed', step: 'build', message: `ビルドが時間切れ(${raw.timedOut} 秒)。反映していません` } }
  const e = (res?.error ?? {}) as Json
  const head = redact(String(e.message ?? (raw.stderr.trim() || raw.stdout.trim() || `終了コード ${raw.code}`)).split('\n')[0] ?? '').slice(0, 160)
  const tail = lastLines(e.tail ?? res?.tail ?? '', 20, 900)
  return { ok: false, error: { code: String(e.code ?? 'build_failed'), step: 'build', message: `ビルドに失敗したので反映していません: ${head}${tail ? `\n${tail}` : ''}` } }
}

export function planList(res: Json): string[] {
  const plan = (Array.isArray(res.plan) ? res.plan : []) as Json[]
  return plan.map((p, k) => `${p.i ?? k + 1}. ${redact(String(p.summary ?? `${p.op ?? ''} ${p.code ?? ''}`))}`)
}
export const planWarnings = (res: Json): string[] => (Array.isArray(res.warnings) ? (res.warnings as unknown[]).map(w => redact(String(w))) : [])

export function formatFormChange(appId: string, res: Json | null, raw: Raw): RelayLine[] {
  if (!res || (!res.ok && !res.applied)) return [{ text: `フォームの変更 アプリ ${appId}`, tone: 'head' }, ...errorLines(res, raw)]
  const applied = (Array.isArray(res.applied) ? res.applied : []) as Json[]
  return [
    { text: `${res.ok ? '✓' : '✗'} フォームの変更 アプリ ${appId}${res.seconds !== undefined ? ` ${res.seconds} 秒` : ''}${res.ok ? '' : '(途中で止まりました)'}`, tone: res.ok ? 'ok' : 'err' },
    ...applied.map(a => ({
      text: `  ${a.i ?? '?'}. ${a.op ?? ''} ${a.code ?? ''} ${a.ok === false ? `✗ ${redact(String(a.error?.message ?? a.error ?? ''))}` : '✓'}`,
      tone: a.ok === false ? ('err' as const) : undefined,
    })),
    ...(res.error ? errorLines(res, raw).slice(1) : []),
    ...(res.backup ? [{ text: '  実行前のフォームは控えました', tone: 'dim' as const }] : []),
  ]
}

export function digestFormChange(appId: string, res: Json | null, raw: Raw): string {
  if (!res || (!res.ok && !res.applied)) return digestError(`アプリ ${appId} のフォームを変えられません`, res, raw)
  const applied = (Array.isArray(res.applied) ? res.applied : []) as Json[]
  return clipDigest(
    [`mod からの報告: アプリ ${appId} のフォームを変更${res.ok ? '' : '(途中で止まった)'}`, '| 手 | 結果 |', '|---|---|'],
    applied.map(a => `| ${cell(`${a.i ?? '?'} ${a.op ?? ''} ${a.code ?? ''}`)} | ${a.ok === false ? `NG ${cell(short(String(a.error?.message ?? a.error ?? ''), 120))}` : 'OK'} |`),
  )
}

export function mdNextCleanup(res: Json | null, raw: Raw): string {
  if (!res?.ok) return redact(`8 試験データを片付ける\n片付けられませんでした: ${String(res?.error?.message ?? raw.stderr ?? '理由不明').split('\n')[0]}`)
  const missing = Array.isArray(res.missing) ? res.missing.length : nm(res.missing)
  return redact(`8 試験データを片付ける\n消したレコード: ${Array.isArray(res.deleted) ? res.deleted.length : nm(res.deleted)} 件${missing ? `(既に無かった ${missing} 件)` : ''}`)
}
