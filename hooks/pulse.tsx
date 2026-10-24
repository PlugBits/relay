// 反映の鼓動: 保存 → pack → アップロード → 反映 → 画面チェック の経過を pane の上に出す。
// 純関数だけ(状態は持たない)。register が Pulse を JSON で保存し、ここへ渡す。
// 秘匿: URL・ホスト名は一切残さない。ファイル名(basename)と行番号だけ。
import type { Pulse, PulseError, PulseStage, StageKey } from './views'

const LABELS: [StageKey, string][] = [
  ['save', '保存'],
  ['pack', 'pack'],
  ['upload', 'アップロード'],
  ['apply', '反映'],
  ['check', '画面チェック'],
]
// deploy JSON の steps[].name → 段
const STEP_STAGE: Record<string, StageKey> = {
  pack: 'pack',
  backup: 'upload',
  upload: 'upload',
  install: 'upload',
  'app-plugins': 'apply',
  config: 'apply',
  deploy: 'apply',
}
const MAX_ERRORS = 10

const r1 = (n: number) => Math.round(n * 10) / 10
const setStage = (p: Pulse, key: StageKey, patch: Partial<PulseStage>): Pulse => ({
  ...p,
  stages: p.stages.map(s => (s.key === key ? { ...s, ...patch } : s)),
})
const skipAfter = (p: Pulse, key: StageKey): Pulse => {
  const at = p.stages.findIndex(s => s.key === key)
  return { ...p, stages: p.stages.map((s, i) => (i > at && s.status !== 'ok' ? { ...s, status: 'skip' as const } : s)) }
}
const finish = (p: Pulse, now: number): Pulse => ({
  ...p,
  finishedAt: now,
  // 合計は壁時計(開始〜終了)。ステージ秒の和だと待ち時間が抜けて「2分」の材料にならない
  totalSeconds: r1(Math.max(0, now - p.startedAt) / 1000),
})

export function initPulse(name: string, appId: string, now: number): Pulse {
  return {
    name,
    appId,
    startedAt: now,
    stages: LABELS.map(([key, label]) => ({ key, label, status: key === 'save' ? ('run' as const) : ('wait' as const) })),
    errors: [],
  }
}

export function applyBuild(p: Pulse, bld: { ok?: boolean; built?: boolean; seconds?: number } | null): Pulse {
  if (!bld || bld.ok === false) return skipAfter(setStage(p, 'save', { status: 'err' }), 'save')
  const patch: Partial<PulseStage> = { status: 'ok' }
  if (bld.built) {
    patch.note = 'ビルド'
    if (typeof bld.seconds === 'number') patch.seconds = r1(bld.seconds)
  }
  let q = setStage(p, 'save', patch)
  for (const k of ['pack', 'upload', 'apply'] as StageKey[]) q = setStage(q, k, { status: 'run' })
  return q
}

export function applyDeploy(p: Pulse, dep: Record<string, any> | null): Pulse {
  const steps: any[] = Array.isArray(dep?.steps) ? dep!.steps : []
  const order: StageKey[] = ['pack', 'upload', 'apply']
  const has = (k: StageKey) => steps.some(s => STEP_STAGE[String(s?.name)] === k)
  let failed: StageKey | null = null
  for (const k of order) {
    if (steps.some(s => STEP_STAGE[String(s?.name)] === k && s?.ok === false)) { failed = k; break }
  }
  if (!failed && (!dep || dep.ok === false)) failed = order.find(k => !has(k)) ?? 'apply'
  let q = p
  for (const k of order) {
    const mine = steps.filter(s => STEP_STAGE[String(s?.name)] === k)
    const ms = mine.reduce((a, s) => a + (Number(s?.ms) || 0), 0)
    const seconds = mine.length ? r1(ms / 1000) : undefined
    const idx = order.indexOf(k)
    const fidx = failed ? order.indexOf(failed) : 99
    if (idx < fidx) q = setStage(q, k, { status: 'ok', seconds })
    else if (idx === fidx) q = setStage(q, k, { status: 'err', seconds })
    else q = setStage(q, k, { status: 'skip' })
  }
  if (failed) return setStage(q, 'check', { status: 'skip' })
  return setStage(q, 'check', { status: 'run' })
}

// ---- エラー収集(URL・ホストを残さない) ----
const URL_RE = /https?:\/\/[^\s)'"<>]+/g
const HOST_RE = /\b[\w-]+(?:\.[\w-]+)*\.(?:cybozu|kintone)(?:-dev)?\.(?:com|cn)\b/gi

// 'https://h/p/desktop.js?x#y:12:5' → { name: 'desktop.js', line: 12 }
function locate(s: unknown): { name?: string; line?: number } {
  if (typeof s !== 'string') return {}
  const m = s.match(/https?:\/\/[^\s)'"<>]+/) ?? s.match(/([\w.\-/]+\.(?:js|mjs|ts|tsx|jsx)):(\d+)/)
  if (!m) {
    const l = s.match(/:(\d+)(?::\d+)?\)?\s*$/)
    return l ? { line: Number(l[1]) } : {}
  }
  let u = m[0]
  let line: number | undefined
  const t = u.match(/:(\d+)(?::(\d+))?$/)
  if (t && !/^https?:\/\/[^/]*:\d+$/.test(u)) { line = Number(t[1]); u = u.slice(0, t.index) }
  u = u.replace(/^https?:\/\/[^/]*/i, '').replace(/[?#].*$/, '')
  const base = u.split('/').filter(Boolean).pop() ?? ''
  // JS だけをファイル名として受ける(kintone のプラグイン配信は download.do?…で、名前が出ない → manifest から推定)
  const name = /^[\w.\-]+\.(?:js|mjs|cjs)$/i.test(base) ? base : undefined
  return { name, line }
}

function scrub(text: string): string {
  return String(text ?? '')
    .replace(URL_RE, u => {
      const { name } = locate(u.replace(/:\d+(?::\d+)?$/, ''))
      const ln = u.match(/:(\d+)(?::\d+)?$/)
      return name ? (ln ? `${name}:${ln[1]}` : name) : ''
    })
    .replace(HOST_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

type ErrWithName = PulseError & { _name?: string }

export function collectErrors(probes: { appId?: string; json: Record<string, any> | null }[]): PulseError[] {
  const out: ErrWithName[] = []
  const seen = new Set<string>()
  const add = (e: ErrWithName) => {
    const k = `${e.kind}|${e.page ?? ''}|${e.message}|${e.line ?? ''}`
    if (seen.has(k)) return
    seen.add(k)
    out.push(e)
  }
  for (const pr of probes ?? []) {
    for (const pg of pr?.json?.pages ?? []) {
      const page = typeof pg?.name === 'string' ? scrub(pg.name).slice(0, 40) || undefined : undefined
      for (const c of pg?.consoleErrors ?? []) {
        const loc = locate(c?.location)
        add({ kind: 'console', message: scrub(c?.text ?? c?.message ?? ''), page, line: loc.line, _name: loc.name })
      }
      for (const c of pg?.pageErrors ?? []) {
        const loc = locate(c?.at)
        // pageerror の stack(Playwright が組む)は行・桁とも 0 始まり。10/24 開発環境で確認: 5行5桁目が「:4:4」(console の行は kin-probe が +1 済み)
        add({ kind: 'pageerror', message: scrub(c?.message ?? ''), page, line: loc.line === undefined ? undefined : loc.line + 1, _name: loc.name })
      }
    }
  }
  // _name は attachSnippets が読む。外へは出ない(列挙しない)
  return out.slice(0, MAX_ERRORS).map(e => {
    const { _name, ...rest } = e
    Object.defineProperty(rest, '_name', { value: _name, enumerable: false })
    return rest as PulseError
  })
}

export async function attachSnippets(
  errors: PulseError[],
  manifestJs: string[],
  readFile: (rel: string) => Promise<string | null>,
): Promise<PulseError[]> {
  const local = (manifestJs ?? []).filter(f => typeof f === 'string' && f && !/^https?:\/\//i.test(f) && !f.startsWith('/') && !f.split('/').includes('..'))
  const out: PulseError[] = []
  for (const e of errors) {
    const name: string | undefined = (e as any)._name
    let file: string | undefined
    let guessed = false
    if (name) file = local.find(f => f.split('/').pop() === name)
    else if (e.line && local.length === 1) { file = local[0]; guessed = true }
    if (!file) { out.push({ ...e }); continue }
    const next: PulseError = { ...e, file }
    if (guessed) next.guessed = true
    if (e.line && e.line > 0) {
      let src: string | null = null
      try { src = await readFile(file) } catch { src = null }
      if (src != null) {
        const lines = src.replace(/\r\n?/g, '\n').split('\n')
        if (lines[lines.length - 1] === '') lines.pop()
        if (e.line <= lines.length) {
          const start = Math.max(1, e.line - 3)
          const end = Math.min(lines.length, e.line + 3)
          next.snippet = { startLine: start, source: lines.slice(start - 1, end).join('\n'), language: 'javascript' }
        }
      }
    }
    out.push(next)
  }
  return out
}

export function applyProbe(p: Pulse, probes: { appId: string; json: Record<string, any> | null }[], now: number): Pulse {
  const errors = collectErrors(probes)
  if (!probes || probes.length === 0) return finish(setStage(p, 'check', { status: 'skip' }), now)
  const seconds = r1(probes.reduce((a, x) => a + (Number(x.json?.seconds) || 0), 0))
  const bad = probes.some(x => !x.json || x.json.ok === false) || errors.length > 0
  return finish({ ...setStage(p, 'check', { status: bad ? 'err' : 'ok', seconds }), errors }, now)
}

export function failPulse(p: Pulse, now: number, message: string): Pulse {
  const at = p.stages.findIndex(s => s.status === 'run' || s.status === 'wait')
  const idx = at < 0 ? p.stages.length - 1 : at
  const stages = p.stages.map((s, i) =>
    i === idx ? { ...s, status: 'err' as const, note: scrub(message).slice(0, 80) || undefined } : i > idx && s.status !== 'ok' ? { ...s, status: 'skip' as const } : s,
  )
  return finish({ ...p, stages }, now)
}

export function fixPromptText(err: PulseError): string {
  const where = err.file ? `${err.file}${err.line ? `:${err.line}` : ''} の ` : ''
  return `${where}${err.message} を直して`
}

// 該当行を '-' 行にした単一ハンクの diff(Code の format:'diff' が行を赤く塗る)
export function snippetDiff(err: PulseError): string | null {
  const sn = err.snippet
  if (!sn || !err.line) return null
  const lines = sn.source.split('\n')
  const k = err.line - sn.startLine
  if (k < 0 || k >= lines.length) return null
  const body = lines.map((l, i) => `${i === k ? '-' : ' '}${l}`).join('\n')
  return `@@ -${sn.startLine},${lines.length} +${sn.startLine},${lines.length - 1} @@\n${body}`
}

const MARK: Record<string, string> = { run: '⟳', ok: '✓', err: '✗', wait: '·', skip: '–' }

export function renderPulse(el: any, surface: string, p: Pulse, onFix: (err: PulseError) => void): unknown {
  const { Box, Text, Button, Code, Markdown } = el
  const stageText = (s: PulseStage) => {
    const parts = [s.label]
    if (s.seconds != null) parts.push(`${s.seconds}s`)
    if (s.note) parts.push(s.note)
    parts.push(MARK[s.status] ?? '·')
    return parts.join(' ')
  }
  const color = (st: string) => (st === 'ok' ? 'green' : st === 'err' ? 'red' : undefined)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap">
        {p.stages.map((s, i) => (
          <Box key={`pulse-st-${s.key}`}>
            <Text color={color(s.status)} dimColor={s.status === 'wait' || s.status === 'skip'}>
              {stageText(s)}
            </Text>
            {i < p.stages.length - 1 && <Text dimColor>{' → '}</Text>}
          </Box>
        ))}
      </Box>
      {p.totalSeconds != null && <Text dimColor>{`合計 ${Math.round(p.totalSeconds)}秒`}</Text>}
      {p.errors.map((er, i) => {
        const diff = snippetDiff(er)
        const head = `${er.kind === 'pageerror' ? '未捕捉例外' : 'console'}${er.page ? ` [${er.page}]` : ''}${er.file ? ` ${er.file}${er.line ? `:${er.line}` : ''}${er.guessed ? '(推定)' : ''}` : ''} ${er.message}`
        return (
          <Box key={`pulse-er-${i}`} flexDirection="column">
            <Text color="red">{head}</Text>
            {er.snippet &&
              (Code ? (
                diff ? (
                  <Code key={`pulse-code-${i}`} source={diff} format="diff" language={er.snippet.language} />
                ) : (
                  <Code key={`pulse-code-${i}`} source={er.snippet.source} startLine={er.snippet.startLine} language={er.snippet.language} />
                )
              ) : (
                er.snippet.source.split('\n').map((l, j) => (
                  <Text key={`pulse-ln-${i}-${j}`} dimColor={er.snippet!.startLine + j !== er.line} color={er.snippet!.startLine + j === er.line ? 'red' : undefined}>
                    {`${er.snippet!.startLine + j} ${l}`}
                  </Text>
                ))
              ))}
            <Button key={`pulse-fix-${i}`} label="直す" onPress={() => onFix(er)} />
          </Box>
        )
      })}
      {p.result && (
        <Box flexDirection="column">
          <Text weight="bold">{p.result.title}</Text>
          {Markdown ? (
            <Markdown text={p.result.md} />
          ) : (
            p.result.md.split('\n').map((l, i) => <Text key={`pulse-md-${i}`}>{l}</Text>)
          )}
        </Box>
      )}
    </Box>
  )
}
