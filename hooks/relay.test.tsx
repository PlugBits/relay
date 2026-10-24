import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'plugbits-relay',
  component: 'Pane',
  requestId: 'relay',
  props: {
    title: 'プラグイン作成 mod',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const APPS = { ok: true, apps: [{ appId: '12', name: '製造管理' }, { appId: '13', name: '在庫' }] }
const FORM = {
  ok: true,
  fields: [
    { code: 'title', label: 'タイトル', type: 'SINGLE_LINE_TEXT' },
    { code: 'rows', label: '明細', type: 'SUBTABLE', subtable: [{ code: 'qty', label: '数量', type: 'NUMBER' }] },
  ],
  plugins: [{ id: 'abcdefghijklmnopabcdefghijklmnop', name: 'foo' }],
  customize: { desktop: { js: ['app.js'], css: [] }, mobile: { js: [], css: [] } },
}
const DEPLOY_OK = { ok: true, pluginId: 'pid', appId: '12', seconds: 7.5, steps: [] }
const PROBE_BAD = {
  ok: false,
  appId: '12',
  seconds: 3,
  summary: 'mod からの報告: 一覧 TypeError: x is not defined (a.js:3) / events index.show×1',
  pages: [
    {
      name: 'index',
      consoleErrors: [],
      pageErrors: [{ message: 'TypeError: x is not defined', at: 'a.js:3' }],
      failedRequests: [],
      events: [{ type: 'app.record.index.show', count: 1 }],
      eventOrder: ['app.record.index.show'],
    },
  ],
}

type Script = Record<string, unknown> // "kin-loop.mjs apps" 等 → JSON
const DEFAULT_SCRIPT: Script = { 'kin-loop.mjs mode': { ok: true, mode: 'dev' } }
const PROD: Script = { 'kin-loop.mjs mode': { ok: true, mode: 'prod' } }
const DENIED = {
  ok: false,
  error: { code: 'denied', message: 'アプリ 12 は本番への反映を許可していません(KINTONE_PROD_APPS=42)。お試し用のアプリの番号を KINTONE_PROD_APPS に入れてください' },
}
const clock: { expireAfterMs: number; waits?: number[] } = { expireAfterMs: -1 }
const sink: { toasts: string[]; registered: string[] } = { toasts: [], registered: [] }
const wait = (ms = 60) => new Promise(r => (globalThis as any).setTimeout(r, ms))
const deploys = (calls: string[][]) => calls.filter(c => c[2] === 'deploy')

// $.process.spawn の下に置く偽の子。argv を記録し、スクリプトの JSON を 1 行で返す
function fakeProcess(on: any, script: Script, calls: string[][]) {
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[] }) {
    calls.push([...e.argv])
    const [bin = '', file = '', ...args] = e.argv
    if (file === '--version') {
      yield { stream: 'stdout' as const, text: 'v24.0.0\n' }
      return { value: { code: 0, signal: null } }
    }
    // v0.8: kin-build は、スクリプトが無ければ「ビルド無し(そのまま)」を返す
    if (file.split('/').pop() === 'kin-build.mjs' && !script['kin-build.mjs']) {
      yield { stream: 'stdout' as const, text: `${JSON.stringify(args.includes('--check') ? { ok: true, build: null } : { ok: true, built: false, dir: args[0] })}\n` }
      return { value: { code: 0, signal: null } }
    }
    const key = [file.split('/').pop(), args.find(a => !a.startsWith('/') && !a.startsWith('--') && a !== '12' && a !== 'pid') ?? ''].join(' ').trim()
    const out = script[key] ?? DEFAULT_SCRIPT[key] ?? script[file.split('/').pop() ?? ''] ?? { ok: false, error: { message: `no script for ${key} (${bin})` } }
    yield { stream: 'stdout' as const, text: `${JSON.stringify(out)}\n` }
    return { value: { code: 0, signal: null } }
  })
}

async function paneTexts($: any, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const all = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return all.map((t: { text: string }) => t.text).join('\n') as string
}

// v1.1 結果カードの Link の href(URL は Text に出さず Link にだけ)
async function paneLinks($: any, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const l = await ui.findAll({ type: 'Link' })
  await ui.unmount()
  return JSON.stringify(l)
}

// Text と Markdown の文字を全部(v0.9 の結果欄は Markdown)
async function paneAll($: any, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const t = await ui.findAll({ type: 'Text' })
  const m = await ui.findAll({ type: 'Markdown' })
  await ui.unmount()
  return [...t.map((x: { text: string }) => x.text), ...m.map((x: { props?: { text?: string }; text?: string }) => x.props?.text ?? x.text ?? '')].join('\n') as string
}

// $.fs.read が返すファイル(テストごとに空にして使う)
const files: Record<string, any> = {}
function baseHooks(on: any) {
  for (const k of Object.keys(files)) delete files[k]
  on('command.register', () => ({ value: { command: 'kin' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('ui.toast', (_: unknown, e: any) => (sink.toasts.push(JSON.stringify(e)), { value: undefined }))
  // 500ms のデバウンスは即時。子プロセスの時間切れ(30/60/120 秒)は、expireAfterMs と同じ長さのものだけ即時に鳴らす
  on('clock.sleep', (_: unknown, e: { ms: number }) =>
    (clock.waits?.push(e.ms), e.ms < 1000 || e.ms === clock.expireAfterMs ? { value: undefined } : new Promise(() => undefined)),
  )
  on('fs.read', (_: unknown, e: { path: string }) => (files[e.path] !== undefined ? { value: files[e.path] } : { deny: 'ENOENT' }))
}

test('/kin connect lists the apps; an error is shown verbatim', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs apps': APPS }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const r = await $.command.run({ command: 'kin', args: 'connect' } as any)
  expect(r.text).toMatch(/2 件/)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/製造管理 ・ 12/)
  expect(shown).toMatch(/在庫 ・ 13/)
  expect(calls.some(c => c[2] === 'apps')).toBe(true)
})

test('missing env: the setup hint reaches the pane as is, no secret', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  const HINT = '開発環境の接続情報がありません。/x/kintone.env を作ってください(chmod 600):\n  KINTONE_PASSWORD=<パスワード>'
  fakeProcess(on, { 'kin-loop.mjs apps': { ok: false, error: { code: 'missing', message: HINT } } }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'kin', args: 'connect' } as any)
  const shown = await paneTexts($, 'desktop')
  expect(shown).toMatch(/開発環境の接続情報がありません/)
  expect(shown).toMatch(/KINTONE_PASSWORD=<パスワード>/)
})

test('/kin <appId> shows fields, subtable children, plugins, JS/CSS', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs form': FORM }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'kin', args: '12' } as any)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/title ・ タイトル ・ SINGLE_LINE_TEXT/)
  expect(shown).toMatch(/qty ・ 数量 ・ NUMBER/)
  expect(shown).toMatch(/foo ・ abcdefghijklmnop/)
  expect(shown).toMatch(/PC JS: app\.js/)
  expect(shown).toMatch(/反映先: アプリ 12/)
})

test('saving under plugins/<name>/ deploys, probes, and the report rides the next prompt', async ($, on) => {
  const calls: string[][] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs form': FORM, 'kin-loop.mjs deploy': DEPLOY_OK, 'kin-probe.mjs': PROBE_BAD }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'kin', args: '12' } as any)

  // Edit は止められない: 結果はそのまま返る
  const ran = await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/src/a.js', old_string: 'a', new_string: 'b' })
  expect(ran.deny).toBeUndefined()
  await new Promise(r => (globalThis as any).setTimeout(r, 50))

  const deploy = calls.find(c => c[2] === 'deploy')
  expect(deploy?.slice(3)).toEqual(['/w/plugins/foo', '12'])
  expect(calls.some(c => c[2]?.endsWith?.('kin-probe.mjs') || c[1]?.endsWith('kin-probe.mjs'))).toBe(true)

  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/✓ 反映 7\.5 秒/)
  expect(shown).toMatch(/TypeError: x is not defined/)
  expect(shown).toMatch(/設定は画面で/)

  await $.prompt.submit({ text: '直して' } as any)
  expect(seen?.join('\n')).toMatch(/mod からの報告: 一覧 TypeError/)
})

test('no target: pane tells to run /kin first, and nothing is spawned', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  fakeProcess(on, {}, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Write', file_path: 'plugins/foo/manifest.json', content: '{}' })
  await new Promise(r => (globalThis as any).setTimeout(r, 50))
  expect(calls.length).toBe(0)
  expect(await paneTexts($, 'terminal')).toMatch(/\/kin <appId>/)
})

test('edits outside plugins/ are ignored', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs form': FORM }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'kin', args: '12' } as any)
  const before = calls.length
  await $.tool.call({ tool: 'Edit', file_path: '/w/src/plugins.js', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/node_modules/x/i.js', old_string: 'a', new_string: 'b' })
  await new Promise(r => (globalThis as any).setTimeout(r, 50))
  expect(calls.length).toBe(before)
})

test('a failed deploy is shown verbatim and goes to the next prompt; bursts of saves deploy once', async ($, on) => {
  const calls: string[][] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  baseHooks(on)
  const FAIL = {
    ok: false,
    pluginId: 'pid',
    appId: '12',
    seconds: 1,
    steps: [],
    error: { step: 'upload', status: 520, code: 'GAIA_X', message: 'POST /k/v1/file.json -> 520 boom' },
  }
  fakeProcess(on, { 'kin-loop.mjs form': FORM, 'kin-loop.mjs deploy': FAIL }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'kin', args: '12' } as any)

  await Promise.all([
    $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/a.js', old_string: 'a', new_string: 'b' }),
    $.tool.call({ tool: 'Write', file_path: '/w/plugins/foo/b.js', content: 'x' }),
  ])
  await new Promise(r => (globalThis as any).setTimeout(r, 80))

  expect(calls.filter(c => c[2] === 'deploy').length).toBe(1)
  expect(calls.some(c => c[2]?.endsWith?.('kin-probe.mjs') || c[1]?.endsWith('kin-probe.mjs'))).toBe(false)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/✗ 失敗 \[upload\] HTTP 520 GAIA_X/)
  expect(shown).toMatch(/POST \/k\/v1\/file\.json -> 520 boom/)
  await $.prompt.submit({ text: '直して' } as any)
  expect(seen?.join('\n')).toMatch(/mod からの報告: foo の反映に失敗 \[upload\]/)
})

test('without node on PATH, the newest ~/.nvm node is used', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.list', () => ({
    value: [
      { name: 'v20.1.0', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'v24.22.1', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[] }) {
    calls.push([...e.argv])
    if (e.argv[0] === 'node') throw new Error('spawn node ENOENT')
    if (e.argv[1] === '--version') yield { stream: 'stdout' as const, text: 'v24.22.1\n' }
    else yield { stream: 'stdout' as const, text: `${JSON.stringify(APPS)}\n` }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'kin', args: 'connect' } as any)
  expect(calls.some(c => c[0] === '/home/u/.nvm/versions/node/v24.22.1/bin/node' && c[1]?.endsWith('kin-loop.mjs'))).toBe(true)
})

// ---- v0.2 ① 本番の確認 ----

test('prod: a save does not deploy; the pane asks, and the 反映 button deploys then probes', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  fakeProcess(on, { ...PROD, 'kin-loop.mjs form': FORM, 'kin-loop.mjs deploy': DEPLOY_OK, 'kin-probe.mjs': PROBE_BAD }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'kin', args: '12' } as any)

  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/a.js', old_string: 'a', new_string: 'b' })
  await wait()
  expect(deploys(calls).length).toBe(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /アプリ 12 に反映します/ }))?.text).toMatch(/アプリ 12 に反映します/)
  expect(await ui.find({ type: 'Button', key: 'confirm-ok' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'confirm-cancel' })).toBeDefined()
  await ui.press({ key: 'confirm-ok' })
  await wait()
  await ui.unmount()

  expect(deploys(calls).length).toBe(1)
  expect(deploys(calls)[0]?.slice(3)).toEqual(['/w/plugins/foo', '12'])
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/✓ 反映 7\.5 秒/)
  expect(shown).not.toMatch(/アプリ 12 に反映します/)
})

test('prod: /kin ok deploys, /kin cancel does not, and the latest save replaces a pending one', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  fakeProcess(on, { ...PROD, 'kin-loop.mjs form': FORM, 'kin-loop.mjs deploy': DEPLOY_OK, 'kin-probe.mjs': PROBE_BAD }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'kin', args: '12' } as any)

  expect((await $.command.run({ command: 'kin', args: 'ok' } as any)).text).toMatch(/確認待ちはありません/)

  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/a.js', old_string: 'a', new_string: 'b' })
  await wait()
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/bar/a.js', old_string: 'a', new_string: 'b' })
  await wait()
  const c = await $.command.run({ command: 'kin', args: 'cancel' } as any)
  expect(c.text).toMatch(/やめました/)
  expect(deploys(calls).length).toBe(0)

  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/a.js', old_string: 'a', new_string: 'b' })
  await wait()
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/bar/a.js', old_string: 'a', new_string: 'b' })
  await wait()
  const ok = await $.command.run({ command: 'kin', args: 'ok' } as any)
  expect(ok.text).toMatch(/アプリ 12 に反映しました/)
  expect(deploys(calls).length).toBe(1)
  expect(deploys(calls)[0]?.[3]).toBe('/w/plugins/bar')
})

test('prod: a pending confirmation is told to the next prompt, with nothing changed yet', async ($, on) => {
  const calls: string[][] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  baseHooks(on)
  fakeProcess(on, { ...PROD, 'kin-loop.mjs form': FORM }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'kin', args: '12' } as any)
  await $.tool.call({ tool: 'Write', file_path: '/w/plugins/foo/a.js', content: 'x' })
  await wait()
  await $.prompt.submit({ text: '続けて' } as any)
  expect(seen?.join('\n')).toMatch(/確認待ちです.*まだ何も変えていません/)
  expect(calls.some(c => c[2] === 'deploy')).toBe(false)
})

test('prod denied: no deploy, the message names the app, nothing is asked', async ($, on) => {
  const calls: string[][] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs mode': DENIED, 'kin-loop.mjs form': FORM }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'kin', args: '12' } as any)
  await $.tool.call({ tool: 'Write', file_path: '/w/plugins/foo/a.js', content: 'x' })
  await wait()
  expect(deploys(calls).length).toBe(0)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/denied/)
  expect(shown).toMatch(/アプリ 12 は本番への反映を許可していません/)
  expect(shown).not.toMatch(/に反映します/)
  await $.prompt.submit({ text: 'どう?' } as any)
  expect(seen?.join('\n')).toMatch(/止めました.*アプリ 12/)
})

// ---- v0.2 undo ----

const UNDO_CANNOT = {
  ok: true,
  appId: '12',
  restored: false,
  deployed: false,
  cannot: ['app-plugin', 'plugin-version'],
  parts: [
    { name: 'app-plugin', status: 'cannot', message: '戻せません: 画面で外してください(アプリ設定のプラグインから。アプリのプラグインを外す公式 API が無いため)' },
    { name: 'plugin-version', status: 'cannot', message: '戻せません: この deploy で初めて読み込んだプラグインです' },
    { name: 'deploy', status: 'unchanged', message: '戻した物が無いので反映していません' },
  ],
}
const UNDO_OK = {
  ok: true,
  appId: '12',
  restored: true,
  deployed: true,
  cannot: [],
  parts: [
    { name: 'app-plugin', status: 'unchanged', message: 'プラグインは元からアプリに付いていました(外しません)' },
    { name: 'plugin-version', status: 'restored', message: '前の版を読み込み直しました(1.0.2 → 控えの版 1.0.1)' },
    { name: 'deploy', status: 'restored', message: 'アプリ設定を反映しました' },
  ],
}

test('/kin undo on dev runs at once and says 戻せません plainly (pane, text and next prompt)', async ($, on) => {
  const calls: string[][] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs undo': UNDO_CANNOT }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'kin', args: 'undo 12' } as any)
  expect(calls.some(c => c[2] === 'undo' && c[3] === '12')).toBe(true)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/戻せません: 画面で外してください/)
  await $.prompt.submit({ text: 'どう?' } as any)
  expect(seen?.join('\n')).toMatch(/戻せません: アプリのプラグイン・プラグインの版/)
  expect(seen?.join('\n')).toMatch(/\| 部分 \| 結果 \|/)
})

test('/kin undo on prod waits for the confirmation; a restored undo is reported', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  fakeProcess(on, { ...PROD, 'kin-loop.mjs undo': UNDO_OK }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const r = await $.command.run({ command: 'kin', args: 'undo 12' } as any)
  expect(r.text).toMatch(/\/kin ok/)
  expect(calls.some(c => c[2] === 'undo')).toBe(false)
  expect(await paneTexts($, 'terminal')).toMatch(/アプリ 12 を直前の状態に戻します/)

  await $.command.run({ command: 'kin', args: 'ok' } as any)
  expect(calls.some(c => c[2] === 'undo' && c[3] === '12')).toBe(true)
  expect(await paneTexts($, 'terminal')).toMatch(/前の版を読み込み直しました/)
})

test('/kin undo on a denied app is stopped before anything runs', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs mode': DENIED }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'kin', args: 'undo 12' } as any)
  expect(r.text).toMatch(/アプリ 12/)
  expect(calls.some(c => c[2] === 'undo')).toBe(false)
})

// ---- v0.2 ② 文字でも会話へ ----

const BIG_FORM = {
  ok: true,
  mode: 'dev',
  fields: Array.from({ length: 40 }, (_, i) => ({ code: `f${i}`, label: `項目${i}`, type: 'SINGLE_LINE_TEXT' })),
  plugins: [{ id: 'abcdefghijklmnopabcdefghijklmnop', name: 'foo' }],
  customize: { desktop: { js: ['app.js'], css: [] }, mobile: { js: [], css: [] } },
}

test('② /kin <app> text: Markdown table ≤20 lines, cut with the pane notice, rides command text and the next prompt', async ($, on) => {
  const calls: string[][] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs form': BIG_FORM }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const r = await $.command.run({ command: 'kin', args: '12' } as any)
  const md = (r.text ?? '').split('\n\n').slice(1).join('\n\n')
  expect(md.split('\n').length).toBeLessThanOrEqual(20)
  expect(md).toMatch(/\| code \| label \| type \|/)
  expect(md).toMatch(/\| f0 \| 項目0 \| SINGLE_LINE_TEXT \|/)
  expect(md).not.toMatch(/f39/)
  expect(md).toMatch(/プラグイン \(1\): foo/)
  expect(md).toMatch(/JS\/CSS: PC JS: app\.js/)
  expect(md.split('\n').some(l => l === '…(pane に全文)')).toBe(true)

  await $.prompt.submit({ text: '直して' } as any)
  const ctx = seen?.join('\n') ?? ''
  expect(ctx).toMatch(/プラグイン作成 mod の自動報告/)
  expect(ctx).toMatch(/mod からの報告: アプリ 12 のフォーム/)
  expect(ctx).toMatch(/…\(pane に全文\)/)

  // 渡したら空になる: 次のプロンプトには出ない
  await $.prompt.submit({ text: 'もう一度' } as any)
  expect(seen?.join('\n') ?? '').not.toMatch(/アプリ 12 のフォーム/)
})

test('② /kin connect: app list table; a short list is not cut', async ($, on) => {
  const calls: string[][] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs apps': APPS }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'kin', args: 'connect' } as any)
  expect(r.text).toMatch(/\| 製造管理 \| 12 \|/)
  expect(r.text).not.toMatch(/pane に全文/)
  await $.prompt.submit({ text: 'x' } as any)
  expect(seen?.join('\n')).toMatch(/\| 在庫 \| 13 \|/)
})

test('② probe result goes to the next prompt as a table beside the one-line report', async ($, on) => {
  const calls: string[][] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  baseHooks(on)
  fakeProcess(on, { 'kin-loop.mjs form': FORM, 'kin-loop.mjs deploy': DEPLOY_OK, 'kin-probe.mjs': PROBE_BAD }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'kin', args: '12' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/a.js', old_string: 'a', new_string: 'b' })
  await wait()
  await $.prompt.submit({ text: '直して' } as any)
  const ctx = seen?.join('\n') ?? ''
  expect(ctx).toMatch(/mod からの報告: 一覧 TypeError/)
  expect(ctx).toMatch(/\| 画面 \| 結果 \|/)
  expect(ctx).toMatch(/\| 一覧 \| 未捕捉例外 TypeError: x is not defined \(a\.js:3\) \|/)
})

// ---- v0.3 道具(kin_*) ----
const T = 'mcp__plugbits-relay__'
const SECRET_PW = 'hunter2-SECRET'
const STATUS = { ok: true, mode: 'dev', host: 'dev.cybozu.com', prodApps: ['42'], relayVersion: '0.3.0', backups: 2, password: SECRET_PW }
const PLUGINS = {
  ok: true,
  plugins: [{ id: 'abcdefghijklmnopabcdefghijklmnop', name: 'foo', enabled: true }],
  customize: { desktop: { js: ['a.js'], css: [] }, mobile: { js: [], css: [] } },
}
const PROBE_OK = { ok: true, appId: '12', seconds: 2, pages: [{ name: 'index', consoleErrors: [], pageErrors: [], failedRequests: [], events: [], eventOrder: [] }] }
const PROBE_OK_SHEET = { ...PROBE_OK, sheet: '/tmp/s.png' }

// script key = "<file> <subcommand>"(kin-loop.mjs の第1引数)。kin-probe / kin-scaffold は file 名だけ
function fakeTools(on: any, script: Script, calls: string[][]) {
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[] }) {
    calls.push([...e.argv])
    const [, file = '', ...args] = e.argv
    if (file === '--version') {
      yield { stream: 'stdout' as const, text: 'v24.0.0\n' }
      return { value: { code: 0, signal: null } }
    }
    if (file === '-f' || e.argv[0] === 'rm') return { value: { code: 0, signal: null } }
    // v0.8: kin-build は、スクリプトが無ければ「ビルド無し(そのまま)」を返す
    if (file.split('/').pop() === 'kin-build.mjs' && !script['kin-build.mjs']) {
      yield { stream: 'stdout' as const, text: `${JSON.stringify(args.includes('--check') ? { ok: true, build: null } : { ok: true, built: false, dir: args[0] })}\n` }
      return { value: { code: 0, signal: null } }
    }
    const f = file.split('/').pop() ?? ''
    const key = f === 'kin-loop.mjs' || f === 'kin-records.mjs' ? `${f} ${args[0]}` : f
    const given = script[key]
    const out = typeof given === 'function' ? (given as (a: string[]) => unknown)(args) : (given ?? { ok: false, error: { message: `no script for ${key}` } })
    yield { stream: 'stdout' as const, text: `${JSON.stringify(out)}\n` }
    return { value: { code: 0, signal: null } }
  })
}
const toolHooks = (on: any, written: { path: string; text: string }[] = []) => {
  baseHooks(on)
  on('tool.register', (_: unknown, e: { name: string }) => (sink.registered.push(e.name), { value: { tool: `${T}${e.name}` } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    written.push(e)
    return { value: undefined }
  })
}
const callTool = async ($: any, name: string, input: Record<string, unknown> = {}) => {
  const r = await $.tool.call({ tool: `${T}${name}`, ...input })
  return String(r.result ?? r.text ?? r.deny ?? '')
}
const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const CONTRACT: Script = {
  'kin-loop.mjs status': STATUS,
  'kin-loop.mjs apps': { ok: true, apps: [{ appId: '12', name: '製造管理', spaceId: null }] },
  'kin-loop.mjs form': {
    ok: true,
    fields: [{ code: 'title', label: 'タイトル', type: 'SINGLE_LINE_TEXT', required: true }, { code: 's', label: '状態', type: 'DROP_DOWN', options: ['新規', '完了'] }],
  },
  'kin-loop.mjs plugins': PLUGINS,
  'kin-loop.mjs records': { ok: true, totalCount: 1, records: [{ title: { value: 'a' } }] },
  'kin-loop.mjs backups': { ok: true, backups: [{ file: 'f1', createdAt: '2026-10-23T01:00:00Z', pluginId: 'p', pluginName: 'foo', version: '3', undone: false }] },
  'kin-loop.mjs mode': { ok: true, mode: 'dev' },
  'kin-loop.mjs deploy': DEPLOY_OK,
  'kin-loop.mjs undo': { ok: true, appId: '12', restored: true, parts: [{ name: 'plugin', message: '戻した' }], cannot: [] },
  'kin-loop.mjs customize': { ok: true, appId: '12', seconds: 3 },
  'kin-probe.mjs': PROBE_OK,
  'kin-scaffold.mjs': { ok: true, dir: '/w/plugins/foo', files: ['manifest.json', 'desktop.js'] },
}

test('tools: all fourteen are registered under their exact names', async ($, on) => {
  const names: string[] = []
  baseHooks(on)
  on('env.get', { name: 'RELAY_FORM_CHANGE' }, () => ({ value: '1' }))
  const props: string[] = []
  on('tool.register', (_: unknown, e: { name: string; description: string; inputSchema: any }) => {
    names.push(e.name)
    props.push(...Object.keys(e.inputSchema?.properties ?? {}))
    return { value: { tool: `${T}${e.name}` } }
  })
  await $.session.start(START)
  // 道具の引数に接続先・認証は無い
  expect(props.filter(k => /host|url|user|pass|auth|token/i.test(k))).toEqual([])
  expect(names.sort()).toEqual(
    ['kin_apps', 'kin_backups', 'kin_customize', 'kin_deploy', 'kin_form', 'kin_form_change', 'kin_plugins', 'kin_probe', 'kin_records', 'kin_records_cleanup', 'kin_records_write', 'kin_scaffold', 'kin_status', 'kin_undo'].sort(),
  )
})

test('tools: read-only ones run on mocks, pass the right argv, and never leak the password', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, CONTRACT, calls)
  await $.session.start(START)

  const status = await callTool($, 'kin_status')
  expect(status).toMatch(/dev\.cybozu\.com/)
  expect(status).not.toMatch(new RegExp(SECRET_PW))
  expect(await callTool($, 'kin_apps')).toMatch(/製造管理/)
  const form = await callTool($, 'kin_form', { appId: '12' })
  expect(form).toMatch(/"required":true/)
  expect(form).toMatch(/完了/)
  expect(await callTool($, 'kin_plugins', { appId: '12' })).toMatch(/foo/)
  const rec = await callTool($, 'kin_records', { appId: '12', query: 'title = "a"', limit: 99, fields: ['title', 'status'] })
  expect(rec).toMatch(/totalCount/)
  const recCall = calls.find(c => c[2] === 'records')!
  expect(recCall.slice(3)).toEqual(['12', '--limit', '20', '--query', 'title = "a"', '--fields', 'title,status'])
  expect(await callTool($, 'kin_backups', { appId: '12' })).toMatch(/foo/)

  const probe = await callTool($, 'kin_probe', { appId: '12', pages: ['index'] })
  expect(probe).toMatch(/アプリ 12/)
  expect(calls.find(c => c[2] === '12' && c[1]?.endsWith('kin-probe.mjs'))?.slice(2)).toEqual(['12', '--pages', 'index'])
  // pane も更新される
  expect(await paneTexts($, 'terminal')).toMatch(/画面|index/)

  // 読む系は mode を聞かず、確認も立てない
  expect(calls.some(c => c[2] === 'mode')).toBe(false)
})

test('tools: bad input is refused before anything runs (no host / url parameters either)', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, CONTRACT, calls)
  await $.session.start(START)
  expect(await callTool($, 'kin_form', { appId: '12; rm -rf /' })).toMatch(/bad_input/)
  expect(await callTool($, 'kin_probe', { appId: '12', pages: ['evil'] })).toMatch(/bad_input/)
  const n = calls.filter(c => c[1]?.endsWith('.mjs')).length
  expect(n).toBe(0)
})

test('tools: scaffold writes fields via a temp file, passes --root cwd, and rejects bad names', async ($, on) => {
  const calls: string[][] = []
  const written: { path: string; text: string }[] = []
  toolHooks(on, written)
  fakeTools(on, CONTRACT, calls)
  await $.session.start(START)

  const r = await callTool($, 'kin_scaffold', { name: 'foo', kind: 'event', appId: '12' })
  expect(r).toMatch(/"ok":true/)
  const sc = calls.find(c => c[1]?.endsWith('kin-scaffold.mjs'))!
  expect(sc.slice(2, 5)).toEqual(['foo', 'event', '--root'])
  expect(sc[5]).toBe('/w')
  const idx = sc.indexOf('--fields-json')
  expect(sc[idx - 2]).toBe('--app')
  expect(written[0]?.path).toBe(sc[idx + 1])
  expect(JSON.parse(written[0]!.text).fields[0].code).toBe('title')
  expect(calls.some(c => c[0] === 'rm' && c[2] === sc[idx + 1])).toBe(true)
  // scaffold はファイルを CLI で書く。Edit/Write ではないので自動反映は走らない
  await wait(700)
  expect(deploys(calls).length).toBe(0)

  expect(await callTool($, 'kin_scaffold', { name: '../evil', kind: 'event' })).toMatch(/bad_input/)
  expect(await callTool($, 'kin_scaffold', { name: 'x', kind: 'weird' })).toMatch(/bad_input/)
  // appId 無しは form を呼ばず一時ファイルも作らない
  const before = written.length
  await callTool($, 'kin_scaffold', { name: 'bar', kind: 'config-only' })
  expect(written.length).toBe(before)
})

test('tools: dev write runs at once (deploy, undo, customize) and the deploy result carries the probe', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, CONTRACT, calls)
  await $.session.start(START)

  const dep = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(dep).toMatch(/foo をアプリ 12 に反映しました/)
  expect(dep).toMatch(/画面チェック/)
  expect(deploys(calls)[0]?.slice(3)).toEqual(['/w/plugins/foo', '12'])
  expect(await paneTexts($, 'terminal')).toMatch(/✓ 反映 7\.5 秒/)

  expect(await callTool($, 'kin_undo', { appId: '12' })).toMatch(/元に戻す/)
  expect(calls.some(c => c[2] === 'undo')).toBe(true)

  const cu = await callTool($, 'kin_customize', { appId: '12', js: ['src/a.js', '/w/src/b.js'], css: ['a.css'], mobileJs: ['m.js'] })
  expect(cu).toMatch(/"ok":true/)
  const cc = calls.find(c => c[2] === 'customize')!
  expect(cc.slice(3)).toEqual(['12', '--js', '/w/src/a.js,/w/src/b.js', '--css', '/w/a.css', '--mobile-js', '/w/m.js'])
})

test('tools: prod write returns awaiting_human_confirmation and runs nothing; /kin ok then runs it; cancel does not', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, { ...CONTRACT, 'kin-loop.mjs mode': { ok: true, mode: 'prod' } }, calls)
  await $.session.start(START)

  const r = JSON.parse(await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' }))
  expect(r.status).toBe('awaiting_human_confirmation')
  expect(r.message).toBe('本番のアプリ 12 への反映は人の確認待ちです。画面のボタンか /kin ok で通ります')
  expect(deploys(calls).length).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'confirm-ok' })).toBeDefined()
  await ui.unmount()

  // モデルが道具をもう一度呼んでも、道具のどの道でも確認は通らない
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  await callTool($, 'kin_status')
  expect(deploys(calls).length).toBe(0)

  const ok = await $.command.run({ command: 'kin', args: 'ok' } as any)
  expect(ok.text).toMatch(/アプリ 12 に反映しました/)
  expect(deploys(calls).length).toBe(1)
  expect(deploys(calls)[0]?.slice(3)).toEqual(['/w/plugins/foo', '12'])

  // undo
  expect(JSON.parse(await callTool($, 'kin_undo', { appId: '12' })).status).toBe('awaiting_human_confirmation')
  expect(calls.some(c => c[2] === 'undo')).toBe(false)
  await $.command.run({ command: 'kin', args: 'cancel' } as any)
  expect(calls.some(c => c[2] === 'undo')).toBe(false)
  await callTool($, 'kin_undo', { appId: '12' })
  await $.command.run({ command: 'kin', args: 'ok' } as any)
  expect(calls.some(c => c[2] === 'undo')).toBe(true)

  // customize
  expect(JSON.parse(await callTool($, 'kin_customize', { appId: '12', js: ['a.js'] })).status).toBe('awaiting_human_confirmation')
  expect(calls.some(c => c[2] === 'customize')).toBe(false)
  await $.command.run({ command: 'kin', args: 'ok' } as any)
  expect(calls.find(c => c[2] === 'customize')?.slice(3)).toEqual(['12', '--js', '/w/a.js'])
})

test('tools: unknown or denied mode fails closed (nothing runs, no confirmation)', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, { ...CONTRACT, 'kin-loop.mjs mode': DENIED }, calls)
  await $.session.start(START)
  const r = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(r).toMatch(/denied|許可していません/)
  expect(r).not.toMatch(/awaiting_human_confirmation/)
  expect(deploys(calls).length).toBe(0)
  expect((await $.command.run({ command: 'kin', args: 'ok' } as any)).text).toMatch(/確認待ちはありません/)
})

test('tools: paths outside plugins/ (deploy) or cwd (customize) are rejected', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, CONTRACT, calls)
  await $.session.start(START)
  for (const dir of ['/etc', '../x', 'plugins/../src', 'plugins', '/w/plugins/../../etc', 'src/foo', '/w/plugins/foo/.keys', '-rf']) {
    expect(await callTool($, 'kin_deploy', { pluginDir: dir, appId: '12' })).toMatch(/path_rejected/)
  }
  for (const f of ['/etc/passwd', '../secret.js', 'a/../../b.js', '.keys/x.ppk', 'kintone.env']) {
    expect(await callTool($, 'kin_customize', { appId: '12', js: [f] })).toMatch(/path_rejected/)
  }
  expect(calls.filter(c => c[1]?.endsWith('.mjs')).length).toBe(0)
})

test('tools: kin_deploy and the save auto-deploy for the same plugin run once', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, CONTRACT, calls)
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: '12' } as any)

  // 道具で反映 → 直後に来た保存の自動反映は重ねない
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(deploys(calls).length).toBe(1)
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/a.js', old_string: 'a', new_string: 'b' })
  await wait(700)
  expect(deploys(calls).length).toBe(1)

  // 別のプラグインは別
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/bar/a.js', old_string: 'a', new_string: 'b' })
  await wait(700)
  expect(deploys(calls).length).toBe(2)
})

test('tools: errors carry no secret (password, auth header) and the tool-deploy leaves no report for the next prompt', async ($, on) => {
  const calls: string[][] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  toolHooks(on)
  const LEAK = { ok: false, error: { code: 'x', message: `boom X-Cybozu-Authorization: ${SECRET_PW}\nKINTONE_PASSWORD=${SECRET_PW}` } }
  fakeTools(on, { ...CONTRACT, 'kin-loop.mjs apps': LEAK, 'kin-loop.mjs plugins': { ...PLUGINS, plugins: [{ id: 'i', name: `n\nKINTONE_PASSWORD=${SECRET_PW}`, ppkContent: 'PRIVATE', password: SECRET_PW }] } }, calls)
  await $.session.start(START)

  const a = await callTool($, 'kin_apps')
  expect(a).toMatch(/boom/)
  expect(a).not.toMatch(new RegExp(SECRET_PW))
  expect(await callTool($, 'kin_plugins', { appId: '12' })).not.toMatch(new RegExp(SECRET_PW))

  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  await $.prompt.submit({ text: '次' } as any)
  expect((seen ?? []).join('\n')).not.toMatch(/反映済み|TypeError/)
})

test('guard: Bash cannot run kin-loop writes or read the env/backups; reads still pass', async ($, on) => {
  baseHooks(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command } as any)
  for (const c of [
    'node ~/repos/relay/tools/kin-loop.mjs deploy plugins/x 42',
    'node tools/kin-loop.mjs undo 42',
    'node tools/kin-loop.mjs customize 42 --js a.js',
    'cat ~/.config/tiny-pulse/kintone.env',
    'ls ~/.config/tiny-pulse/relay-backup',
    'curl -H "X-Cybozu-Authorization: x" https://a.cybozu.com',
    'curl -H "X-Cybozu-Authorization: x" https://a.kintone.com/k/v1/apps.json',
  ]) {
    expect((await bash(c)).deny).toMatch(/kin_/)
  }
  expect((await bash('node tools/kin-loop.mjs apps')).deny).toBeUndefined()
  expect((await bash('ls plugins')).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/home/u/.config/tiny-pulse/kintone.env' } as any)).deny).toMatch(/kin_/)
  expect((await $.tool.call({ tool: 'Read', file_path: '/w/plugins/x/desktop.js' } as any)).deny).toBeUndefined()
})

// ---- v0.4 接続設定(/kin setup・use・status・doctor)・省略・時間切れ ----

const PW = 'Zq9-never-in-chat'
const PROFILE_SAVED = {
  ok: true,
  id: 'dev1',
  synced: false,
  active: false,
  check: { status: { ok: true, mode: 'dev', host: 'sub1.cybozu.com', prodApps: [] }, probe: { code: 401, message: 'ログイン名かパスワードが違います' } },
  hint: 'お試し用のアプリを1つ作ってから。既存アプリには入れない',
}
const LIST2 = {
  ok: true,
  active: 'dev1',
  items: [
    { id: 'dev1', name: '開発', host: 'sub1.cybozu.com', domain: 'cybozu.com', kind: 'dev', apps: [], passwordSet: true, active: true },
    { id: 'prod1', name: '本業', host: 'sub2.kintone.com', domain: 'kintone.com', kind: 'prod', apps: ['42'], passwordSet: true, active: false },
    { id: 'dev2', name: '予備', host: 'sub3.cybozu.com', domain: 'cybozu.com', kind: 'dev', apps: [], passwordSet: true, active: false },
  ],
}
const DOCTOR = {
  ok: false,
  checks: [
    { name: 'node', ok: true, message: 'v24' },
    { name: 'chromium', ok: false, message: '画面チェックに必要なものが無い', fix: 'npx playwright install chromium' },
  ],
}

// 子の偽物。argv と stdin(input) を記録。値が 'HANG' なら終わらない子
type Rec = { argv: string[]; input?: string }
function fakeV4(on: any, script: Record<string, unknown>, recs: Rec[]) {
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[]; input?: string }) {
    recs.push({ argv: [...e.argv], ...(e.input === undefined ? {} : { input: e.input }) })
    const [, file = '', ...args] = e.argv
    if (file === '--version') {
      yield { stream: 'stdout' as const, text: 'v24.0.0\n' }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === 'rm') return { value: { code: 0, signal: null } }
    // v0.8: kin-build は、スクリプトが無ければ「ビルド無し(そのまま)」を返す
    if (file.split('/').pop() === 'kin-build.mjs' && !script['kin-build.mjs']) {
      yield { stream: 'stdout' as const, text: `${JSON.stringify(args.includes('--check') ? { ok: true, build: null } : { ok: true, built: false, dir: args[0] })}\n` }
      return { value: { code: 0, signal: null } }
    }
    const f = file.split('/').pop() ?? ''
    const sub = args.find(a => !a.startsWith('/') && !a.startsWith('--') && !/^\d+$/.test(a)) ?? ''
    const key = f === 'kin-loop.mjs' || f === 'kin-profile.mjs' ? `${f} ${sub}` : f
    const out = script[key] ?? { ok: false, error: { message: `no script for ${key}` } }
    if (out === 'HANG') await new Promise(() => undefined)
    yield { stream: 'stdout' as const, text: `${JSON.stringify(out)}\n` }
    return { value: { code: 0, signal: null } }
  })
}

// $.state を覗ける入れ物に(書かれた値を全部記録する)
function memoryState(on: any, writes: string[]) {
  const store = new Map<string, { value: unknown; version: number }>()
  const k = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('state.get', (_: unknown, e: any) => ({ value: store.get(k(e)) ?? { value: undefined, version: 0 } }))
  on('state.set', (_: unknown, e: any) => {
    const cur = store.get(k(e))
    if (e.ifVersion !== undefined && e.ifVersion !== (cur?.version ?? 0)) return { value: { isSet: false, version: cur?.version ?? 0 } }
    const version = (cur?.version ?? 0) + 1
    store.set(k(e), { value: e.value, version })
    writes.push(JSON.stringify(e.value))
    return { value: { isSet: true, version } }
  })
}

const textsOf = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text).join('\n') as string

// 描いた欄のうちパスワード欄の key(f-password-<rev>)
async function pwKey(ui: any): Promise<string> {
  const all = await ui.findAll({ type: 'Input' })
  return (all.map((i: { key?: string }) => i.key ?? '').find((x: string) => x.startsWith('f-password-')) ?? 'f-password-') as string
}

test('/kin setup: saves via the CLI on stdin; the password is in no state, pane, context, toast or tool result', async ($, on) => {
  const recs: Rec[] = []
  const writes: string[] = []
  const toasts = (sink.toasts = [])
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  toolHooks(on)
  memoryState(on, writes)
  fakeV4(on, { ...CONTRACT, 'kin-profile.mjs list': LIST2, 'kin-profile.mjs save': PROFILE_SAVED, 'kin-profile.mjs status': { ok: true, name: '開発', host: 'sub1.cybozu.com', mode: 'dev' } }, recs)
  await $.session.start(START)

  const r = await $.command.run({ command: 'kin', args: 'setup' } as any)
  expect(r.text).not.toMatch(new RegExp(PW))

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await textsOf(ui)).toMatch(/入力中は画面に見えます。会話には残りません/)
  await ui.input({ key: 'f-name', text: '開発' })
  await ui.input({ key: 'f-subdomain', text: 'sub1' })
  await ui.select({ key: 'f-domain', value: 'cybozu.com' })
  await ui.input({ key: 'f-username', text: 'taro' })
  await ui.input({ key: await pwKey(ui), text: PW })
  await ui.select({ key: 'f-kind', value: 'dev' })
  await ui.input({ key: 'f-apps', text: '' })
  await ui.press({ key: 'setup-save' })
  await wait()

  const save = recs.find(c => c.argv[2] === 'save')
  expect(save).toBeDefined()
  expect(save?.argv.join(' ')).not.toMatch(new RegExp(PW))
  const sent = JSON.parse(save?.input ?? '{}')
  expect(sent).toMatchObject({ name: '開発', subdomain: 'sub1', domain: 'cybozu.com', username: 'taro', password: PW, kind: 'dev', apps: [] })
  expect(recs.filter(c => c.input?.includes(PW)).length).toBe(1)

  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const after = await textsOf(ui)
  expect(after).toMatch(/設定済み/)
  expect(after).toMatch(/sub1\.cybozu\.com/)
  expect(after).toMatch(/401 ログイン名かパスワードが違います/)
  expect(after).toMatch(/お試し用のアプリを1つ作ってから/)
  expect(after).toMatch(/「使う」を押してください/)
  expect(await ui.find({ type: 'Button', key: 'use-prod1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'use-dev1' })).toBeUndefined()
  expect(JSON.stringify(await ui.findAll({}))).not.toMatch(new RegExp(PW))
  await ui.unmount()

  expect(await callTool($, 'kin_status')).toMatch(/"profile":"開発"/)
  await $.prompt.submit({ text: '状況は?' } as any)
  const leaks = [writes.join('\n'), toasts.join('\n'), (seen ?? []).join('\n'), recs.map(c => c.argv.join(' ')).join('\n'), after]
  expect(writes.length).toBeGreaterThan(3)
  for (const l of leaks) expect(l).not.toMatch(new RegExp(PW))
  expect(toasts.join('\n')).toMatch(/設定済み/)
})

test('/kin setup: a failed save never shows the password even if the CLI echoes it; arguments are refused', async ($, on) => {
  const recs: Rec[] = []
  baseHooks(on)
  fakeV4(on, { 'kin-profile.mjs list': { ok: true, items: [] }, 'kin-profile.mjs save': { ok: false, error: { code: 'bad_input', message: `パスワード ${PW} は使えません` } } }, recs)
  await $.session.start(START)
  const warn = await $.command.run({ command: 'kin', args: `setup ${PW}` } as any)
  expect(warn.text).toMatch(/何も付けないで/)
  expect(warn.text).not.toMatch(new RegExp(PW))
  expect(recs.length).toBe(0)

  await $.command.run({ command: 'kin', args: 'setup' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'f-name', text: 'x' })
  await ui.input({ key: 'f-subdomain', text: 'sub' })
  await ui.input({ key: 'f-username', text: 'u' })
  await ui.input({ key: await pwKey(ui), text: PW })
  await ui.press({ key: 'setup-save' })
  await wait()
  const t = await textsOf(ui)
  await ui.unmount()
  expect(t).toMatch(/✗ 失敗/)
  expect(t).not.toMatch(new RegExp(PW))
})

async function fillSetup(ui: any, over: Record<string, string> = {}) {
  await ui.input({ key: 'f-name', text: over.name ?? '開発' })
  await ui.input({ key: 'f-subdomain', text: over.sub ?? 'sub1' })
  await ui.input({ key: 'f-username', text: over.user ?? 'taro' })
}

test('v0.6 /kin setup: Enter on the password field saves; the fields keep their values and the password stays unshown', async ($, on) => {
  const recs: Rec[] = []
  const writes: string[] = []
  const toasts = (sink.toasts = [])
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  toolHooks(on)
  memoryState(on, writes)
  fakeV4(on, { ...CONTRACT, 'kin-profile.mjs list': LIST2, 'kin-profile.mjs save': PROFILE_SAVED }, recs)
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: 'setup' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await fillSetup(ui)
  await ui.input({ key: await pwKey(ui), text: PW, submit: true } as any)
  await wait()
  const save = recs.find(c => c.argv[2] === 'save')
  expect(save).toBeDefined()
  expect(JSON.parse(save?.input ?? '{}')).toMatchObject({ name: '開発', subdomain: 'sub1', username: 'taro', password: PW })

  await ui.unmount()
  const ui2 = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = await textsOf(ui2)
  expect(t).toMatch(/保存しました → \/kin use dev1 で切り替え/)
  const all = JSON.stringify(await ui2.findAll({}))
  expect(all).toMatch(/開発/)
  expect(all).toMatch(/sub1/)
  expect(all).toMatch(/taro/)
  expect(all).toMatch(/設定済み\(再入力で上書き\)/)
  await $.prompt.submit({ text: '状況は?' } as any)
  expect((seen ?? []).join('\n')).toMatch(/\/kin use dev1/)
  await ui2.unmount()
  for (const l of [all, t, writes.join('\n'), toasts.join('\n'), (seen ?? []).join('\n'), recs.map(c => c.argv.join(' ')).join('\n')]) expect(l).not.toMatch(new RegExp(PW))
})

test('v0.6 /kin setup: Enter with required fields empty does not call the CLI and lists them in red', async ($, on) => {
  const recs: Rec[] = []
  baseHooks(on)
  fakeV4(on, { 'kin-profile.mjs list': { ok: true, items: [] }, 'kin-profile.mjs save': PROFILE_SAVED }, recs)
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: 'setup' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'f-name', text: '開発' })
  await ui.input({ key: await pwKey(ui), text: '', submit: true } as any)
  await wait()
  expect(recs.some(c => c.argv[2] === 'save')).toBe(false)
  const reds = (await ui.findAll({ type: 'Text' })).filter((x: any) => /^✗/.test(x.text)).map((x: any) => x.text).join('\n')
  expect(reds).toMatch(/サブドメイン・ログイン名・パスワードが空です/)
  await ui.select({ key: 'f-kind', value: 'prod' })
  await ui.press({ key: 'setup-save' })
  await wait()
  const reds2 = (await ui.findAll({ type: 'Text' })).filter((x: any) => /^✗/.test(x.text)).map((x: any) => x.text).join('\n')
  expect(reds2).toMatch(/パスワード・本番のアプリ番号が空です|本番のアプリ番号/)
  expect(recs.some(c => c.argv[2] === 'save')).toBe(false)
  await ui.unmount()
})

test('/kin setup: a surface with no Input says so instead of breaking', async ($, on) => {
  baseHooks(on)
  fakeV4(on, { 'kin-profile.mjs list': { ok: true, items: [] } }, [])
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: 'setup' } as any)
  expect(await paneTexts($, 'terminal')).toMatch(/接続設定/)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  const m = await textsOf(ui)
  await ui.unmount()
  expect(m).toMatch(/入力欄がありません/)
})

test('/kin use: a dev profile switches at once; a prod profile waits for 切り替える or /kin ok', async ($, on) => {
  const recs: Rec[] = []
  baseHooks(on)
  fakeV4(on, { 'kin-profile.mjs list': LIST2, 'kin-profile.mjs use': { ok: true, id: 'dev2', mode: 'dev', host: 'sub3.cybozu.com' } }, recs)
  await $.session.start(START)
  const uses = () => recs.filter(c => c.argv[2] === 'use')

  const d = await $.command.run({ command: 'kin', args: 'use dev2' } as any)
  expect(d.text).toMatch(/予備 に切り替えました/)
  expect(uses().map(c => c.argv.slice(3))).toEqual([['dev2']])
  expect(await paneTexts($, 'terminal')).toMatch(/sub3\.cybozu\.com/)

  const p = await $.command.run({ command: 'kin', args: 'use prod1' } as any)
  expect(p.text).toMatch(/\/kin ok/)
  expect(uses().length).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await textsOf(ui)).toMatch(/接続先を 本業\(本番\)に切り替えます/)
  expect(await ui.find({ type: 'Button', key: 'confirm-ok' })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'kin', args: 'ok' } as any)
  expect(uses().map(c => c.argv.slice(3))).toEqual([['dev2'], ['prod1']])

  await $.command.run({ command: 'kin', args: 'use prod1' } as any)
  await $.command.run({ command: 'kin', args: 'cancel' } as any)
  expect(uses().length).toBe(2)
  expect((await $.command.run({ command: 'kin', args: 'use nope' } as any)).text).toMatch(/ありません/)
})

test('the 使う button in the setup pane switches a non-active profile', async ($, on) => {
  const recs: Rec[] = []
  baseHooks(on)
  fakeV4(on, { 'kin-profile.mjs list': LIST2, 'kin-profile.mjs use': { ok: true, id: 'dev2', mode: 'dev', host: 'sub3.cybozu.com' } }, recs)
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: 'setup' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'use-dev2' })
  await wait()
  await ui.unmount()
  expect(recs.some(c => c.argv[2] === 'use' && c.argv[3] === 'dev2')).toBe(true)
})

test('/kin status and /kin doctor: text and pane; no env says to run /kin setup', async ($, on) => {
  const recs: Rec[] = []
  let seen: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  baseHooks(on)
  fakeV4(
    on,
    {
      'kin-profile.mjs status': { ok: true, active: 'dev1', name: '開発', host: 'sub1.cybozu.com', mode: 'dev', prodApps: ['42'], profiles: 3 },
      'kin-doctor.mjs': DOCTOR,
      'kin-loop.mjs apps': { ok: false, error: { code: 'missing', message: '接続情報がありません' } },
    },
    recs,
  )
  await $.session.start(START)

  const s = await $.command.run({ command: 'kin', args: 'status' } as any)
  expect(s.text).toMatch(/今の接続先: 開発/)
  expect(s.text).toMatch(/\| ホスト \| sub1\.cybozu\.com \|/)
  let shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/ホスト: sub1\.cybozu\.com/)
  expect(shown).toMatch(/モード: 開発/)
  expect(shown).toMatch(/本番に反映してよいアプリ: 42/)

  const d = await $.command.run({ command: 'kin', args: 'doctor' } as any)
  expect(d.text).toMatch(/NG 画面チェックに必要なものが無い → npx playwright install chromium/)
  shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/✓ node: v24/)
  expect(shown).toMatch(/✗ chromium: 画面チェックに必要なものが無い/)
  expect(shown).toMatch(/→ npx playwright install chromium/)
  await $.prompt.submit({ text: '?' } as any)
  expect(seen?.join('\n')).toMatch(/診断/)

  const c = await $.command.run({ command: 'kin', args: 'connect' } as any)
  expect(c.text).toMatch(/\/kin setup で接続先を入れてください/)
  expect(await paneTexts($, 'terminal')).toMatch(/\/kin setup で接続先を入れてください/)
})

test('/kin status with no profile: the setup line, in the pane and the text', async ($, on) => {
  baseHooks(on)
  fakeV4(on, { 'kin-profile.mjs status': { ok: false, error: { code: 'missing', message: 'x' } } }, [])
  await $.session.start(START)
  const s = await $.command.run({ command: 'kin', args: 'status' } as any)
  expect(s.text).toMatch(/\/kin setup で接続先を入れてください/)
  expect(await paneTexts($, 'terminal')).toMatch(/\/kin setup で接続先を入れてください/)
})

test('probe skipped: shown as 省略 (not an error) and the deploy is still a success, in the pane and the tool result', async ($, on) => {
  const recs: Rec[] = []
  const toasts = (sink.toasts = [])
  toolHooks(on)
  const SKIP = { ok: true, skipped: true, skipCode: 'login', reason: 'ログイン不可', summary: 'mod からの報告: 画面チェックは省略(ログイン不可・反映は済)' }
  fakeV4(on, { ...CONTRACT, 'kin-probe.mjs': SKIP }, recs)
  await $.session.start(START)

  const out = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(out).toMatch(/foo をアプリ 12 に反映しました/)
  expect(out).toMatch(/画面チェックは省略\(ログイン不可・反映は済\)/)
  expect(out).not.toMatch(/出来ませんでした/)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/✓ 反映 7\.5 秒/)
  expect(shown).toMatch(/画面チェックは省略\(ログイン不可・反映は済\)/)
  expect(shown).not.toMatch(/✗/)
  expect(toasts.join('\n')).not.toMatch(/エラー|失敗/)

  const probe = await callTool($, 'kin_probe', { appId: '12' })
  expect(probe).toMatch(/省略/)
  expect(probe).not.toMatch(/"ok":false/)
})

test('timeout: a deploy that never ends is stopped and reported as 時間切れ(60 秒), in the pane and the tool result', async ($, on) => {
  const recs: Rec[] = []
  toolHooks(on)
  fakeV4(on, { ...CONTRACT, 'kin-loop.mjs deploy': 'HANG' }, recs)
  clock.expireAfterMs = 60000
  try {
    await $.session.start(START)
    const out = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
    expect(out).toMatch(/時間切れ\(60 秒\)/)
    expect(out).toMatch(/"code":"timeout"/)
    expect(recs.some(c => c.argv[1]?.endsWith('kin-probe.mjs'))).toBe(false)
    const shown = await paneTexts($, 'terminal')
    expect(shown).toMatch(/時間切れ\(60 秒\)/)
    expect(shown).toMatch(/どこまで進んだかは未確認/)
  } finally {
    clock.expireAfterMs = -1
  }
})

test('timeout: probe 120 s, deploy/undo 60 s, other commands 30 s', async ($, on) => {
  const recs: Rec[] = []
  const waits: number[] = (clock.waits = [])
  toolHooks(on)
  clock.expireAfterMs = 120000
  fakeV4(on, { ...CONTRACT, 'kin-probe.mjs': 'HANG' }, recs)
  await $.session.start(START)
  const p = await callTool($, 'kin_probe', { appId: '12' })
  expect(p).toMatch(/時間切れ\(120 秒\)/)
  await callTool($, 'kin_apps')
  await callTool($, 'kin_undo', { appId: '12' })
  clock.expireAfterMs = -1
  clock.waits = undefined
  expect([...new Set(waits.filter(w => w >= 1000))].sort((a, b) => a - b)).toEqual([30000, 60000, 120000])
})

test('guard: Bash cannot save or switch profiles (human-only), and no kin_* tool does it', async ($, on) => {
  const names = (sink.registered = [])
  toolHooks(on)
  await $.session.start(START)
  expect(names.filter(n => /setup|save|profile|use|login|password/.test(n))).toEqual([])
  for (const command of ['node tools/kin-profile.mjs use prod1', 'node tools/kin-profile.mjs save --stdin-file /tmp/x', 'cat ~/.config/tiny-pulse/kintone/dev1.env']) {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(String(r.deny ?? '')).toMatch(/plugbits-relay/)
  }
})

// ---- v0.4 依存が入っていない(marketplace 経由は node_modules が無い) ----
test('deps missing: ERR_MODULE_NOT_FOUND becomes one guidance line in the pane and in the tool result', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[] }) {
    calls.push([...e.argv])
    if (e.argv[1] === '--version') {
      yield { stream: 'stdout' as const, text: 'v24.0.0\n' }
      return { value: { code: 0, signal: null } }
    }
    yield {
      stream: 'stderr' as const,
      text: "node:internal/modules/esm/resolve:873\n  Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@kintone/plugin-packer' imported from /x/tools/kin-loop.mjs\n",
    }
    return { value: { code: 1, signal: null } }
  })
  await $.session.start(START)
  const r = await callTool($, 'kin_apps')
  expect(r).toMatch(/プラグイン作成 mod の依存が入っていません。\/kin doctor を見てください\(端末で npm ci が要ります\)/)
  expect(r).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package/)
  await $.command.run({ command: 'kin', args: 'connect' } as any)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/プラグイン作成 mod の依存が入っていません/)
  expect(shown).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package/)
})

test('v0.5: the looks section is appended last as session, once, and the rest is kept', async ($, on) => {
  toolHooks(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  await $.session.start(START)
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(r.sections.map((s: { id: string }) => s.id)).toEqual(['intro', 'plugbits-relay:looks', 'plugbits-relay-start'])
  const looks = r.sections[1]!
  expect(looks.scope).toBe('session')
  expect(looks.text).toMatch(/51-modern-default/)
  expect(looks.text).toMatch(/RelayUI\.headerButton/)
  expect(looks.text).toMatch(/kintoneplugin-alert/)
  expect(looks.text).toMatch(/2回目は見ない/)
})

test('v0.5: scaffold takes the three new kinds; kin_probe passes --plugin and makes one sheet per call', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, { ...CONTRACT, 'kin-probe.mjs': { ...PROBE_OK_SHEET } }, calls)
  await $.session.start(START)
  for (const kind of ['header-button', 'index-band', 'detail-notice']) {
    expect(await callTool($, 'kin_scaffold', { name: `k-${kind}`, kind })).toMatch(/"ok":true/)
  }
  const pid = 'abcdefghijklmnopabcdefghijklmnop'
  const first = await callTool($, 'kin_probe', { appId: '12', pluginId: pid, screenshots: true })
  expect(first).toMatch(/縮小1枚\(設定・詳細・一覧\): \/tmp\/s\.png/)
  const pc = calls.filter(c => c[1]?.endsWith('kin-probe.mjs'))
  expect(pc[0]!.slice(2, 5)).toEqual(['12', '--plugin', pid])
  expect(pc[0]!.includes('--sheet')).toBe(true)
  const second = await callTool($, 'kin_probe', { appId: '12', pluginId: pid, screenshots: true })
  // v0.8: 依頼ごとに1回(プラグインごとの1回の縛りは外した)
  expect(second).toMatch(/縮小1枚\(設定・詳細・一覧\): \/tmp\/s\.png/)
  const pc2 = calls.filter(c => c[1]?.endsWith('kin-probe.mjs'))
  expect(pc2[1]!.includes('--sheet')).toBe(true)
  // 既定はオフ
  await callTool($, 'kin_probe', { appId: '12' })
  expect(calls.filter(c => c[1]?.endsWith('kin-probe.mjs'))[2]!.includes('--sheet')).toBe(false)
  expect(await callTool($, 'kin_probe', { appId: '12', pluginId: '../x' })).toMatch(/bad_input/)
})

test('v0.6: kin_plugins marks test-looking plugins as 試験用(画面で外せます)', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, { ...CONTRACT, 'kin-loop.mjs plugins': { ...PLUGINS, plugins: [{ id: 'a', name: 'Relay undo テスト', enabled: true }, { id: 'b', name: '一覧集計', enabled: true }] } }, calls)
  await $.session.start(START)
  const md = await callTool($, 'kin_plugins', { appId: '12' })
  expect(md).toMatch(/\| Relay undo テスト \| a \| はい \| 試験用\(画面で外せます\) \|/)
  expect(md).toMatch(/\| 一覧集計 \| b \| はい \|  \|/)
})

// ---- v0.7 反映の後の「次の一手」 ----
const NEXT_DEPLOY = { ...DEPLOY_OK, origin: 'https://ex.cybozu.com' }
const NEXT_SCRIPT: Script = {
  ...CONTRACT,
  'kin-loop.mjs deploy': NEXT_DEPLOY,
  'kin-loop.mjs records': { ok: true, totalCount: 1, records: [{ $id: { type: '__ID__', value: '5' } }] },
  'kin-loop.mjs pack': { ok: true, pluginId: 'pid', version: '3', file: '/w/plugins/foo/dist/foo-3.zip', bytes: 1234 },
  'kin-profile.mjs': { ok: true, items: [{ id: 'dev1', name: '開発', host: 'dev.cybozu.com', kind: 'dev', active: true }, { id: 'prod1', name: '本番', host: 'p.cybozu.com', kind: 'prod', active: false }] },
  'kin-probe.mjs': { ...PROBE_OK, sheet: '/tmp/n.png' },
}
const logs: string[] = []
function nextHooks(on: any, script: Script, calls: string[][]) {
  logs.length = 0
  toolHooks(on)
  on('ui.log', (_: unknown, e: { text: string }) => (logs.push(e.text), { value: undefined }))
  fakeTools(on, script, calls)
}
const START_NEXT = async ($: any) => {
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: '12' } as any)
}

test('v0.7 next: a dev deploy puts 1-7 in the conversation, buttons in the pane, and the list in the tool result', async ($, on) => {
  const calls: string[][] = []
  nextHooks(on, NEXT_SCRIPT, calls)
  await START_NEXT($)
  logs.length = 0
  const res = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  const said = logs.join('\n')
  for (const n of ['1 画面で見る', '2 設定を変える', '3 見た目を見る', '4 もう1本作る', '5 戻す', '6 本番に入れる', '7 終わる']) expect(said).toContain(n)
  expect(said).toMatch(/番号か言葉で返してください$/)
  expect(res).toMatch(/次の一手/)
  expect(res).toMatch(/自分から番号の処理をしない/)
  expect(await paneTexts($, 'terminal')).toMatch(/次の一手/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(await ui.find({ type: 'Button', key: `next-${n}` })).toBeDefined()
  await ui.unmount()
  expect(calls.some(c => c[2] === 'records' && c.includes('$id'))).toBe(true)
  // 1 は URL(一覧と詳細)、2 は設定画面
  const one = await $.command.run({ command: 'kin', args: 'next 1' } as any)
  expect(one.text).toContain('https://ex.cybozu.com/k/12/')
  expect(one.text).toContain('https://ex.cybozu.com/k/12/show#record=5')
  const two = await $.command.run({ command: 'kin', args: 'next ２' } as any)
  expect(two.text).toContain('https://ex.cybozu.com/k/admin/app/12/plugin/config?pluginId=pid')
  expect(two.text).toContain('relay.config.json')
})

test('v0.7 next: a prod-allowed app does not get 6, and the pane press runs the same thing', async ($, on) => {
  const calls: string[][] = []
  nextHooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs mode': { ok: true, mode: 'prod' } }, calls)
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(deploys(calls).length).toBe(0)
  await $.command.run({ command: 'kin', args: 'ok' } as any)
  expect(deploys(calls).length).toBe(1)
  const said = logs.join('\n')
  expect(said).toContain('5 戻す')
  expect(said).toContain('6 本番に入れる(今は無し)')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'next-6' })).toBeUndefined()
  await ui.press({ key: 'next-1' })
  await wait()
  await ui.unmount()
  // v0.9: ボタンは /kin next 1 に落ち、結果は pane の結果欄に(ログ行には出さない)
  expect(await paneLinks($, 'desktop')).toContain('https://ex.cybozu.com/k/12/')
  expect(await paneAll($, 'desktop')).not.toContain('https://')
})

test('v0.7 next: nothing is offered while a prod confirmation waits, and bare numbers pass through', async ($, on) => {
  const calls: string[][] = []
  let reached = ''
  on('prompt.submit', (_, e) => ((reached = e.text), { text: e.text }))
  nextHooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs mode': { ok: true, mode: 'prod' } }, calls)
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(logs.join('\n')).not.toContain('次の一手')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'next-1' })).toBeUndefined()
  await ui.unmount()
  const r = await $.prompt.submit({ text: '2', asUser: true } as any)
  expect(r.drop).toBeUndefined()
  expect(reached).toBe('2')
  expect((await $.command.run({ command: 'kin', args: 'next 2' } as any)).text).toMatch(/出ていません/)
})

test('v0.7 next: 7 packs and returns the path; 3 runs the sheet once and then goes away; 4 clears', async ($, on) => {
  const calls: string[][] = []
  nextHooks(on, NEXT_SCRIPT, calls)
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })

  const three = await $.command.run({ command: 'kin', args: 'next 3' } as any)
  expect(three.text).toContain('/tmp/n.png')
  const probe = calls.filter(c => c[1]?.endsWith('kin-probe.mjs')).pop()!
  expect(probe).toContain('--sheet')
  expect(probe).toContain('--plugin')
  expect((await $.command.run({ command: 'kin', args: 'next 3' } as any)).text).toMatch(/今は選べません/)
  expect((await $.command.run({ command: 'kin', args: 'next 3' } as any)).text).not.toMatch(/^3 見た目/)

  const seven = await $.command.run({ command: 'kin', args: 'next 7' } as any)
  expect(seven.text).toContain('/w/plugins/foo/dist/foo-3.zip')
  const pack = calls.find(c => c[2] === 'pack')!
  expect(pack.slice(3)).toEqual(['/w/plugins/foo'])
  expect((await $.command.run({ command: 'kin', args: 'next 1' } as any)).text).toMatch(/出ていません/)
})

test('v0.7 next: after a sheet seen by kin_probe, 3 is not offered; 6 lists prod profiles; 5 undoes', async ($, on) => {
  const calls: string[][] = []
  nextHooks(on, NEXT_SCRIPT, calls)
  await START_NEXT($)
  await callTool($, 'kin_probe', { appId: '12', pluginId: 'pid'.padEnd(32, 'a').replace(/[^a-z]/g, 'a'), screenshots: true })
  logs.length = 0
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  // pluginId は 'pid' なので別キー。3 は出る
  expect(logs.join('\n')).toContain('3 見た目を見る')
  await $.command.run({ command: 'kin', args: 'next 3' } as any)
  logs.length = 0
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(logs.join('\n')).toContain('3 見た目を見る(今は無し)')
  expect(logs.join('\n')).toContain('7 終わる')

  const six = await $.command.run({ command: 'kin', args: 'next 6' } as any)
  expect(six.text).toMatch(/本番\(prod1・p\.cybozu\.com\)/)
  expect(six.text).toContain('/kin use prod1')
  const five = await $.command.run({ command: 'kin', args: 'next 5' } as any)
  expect(five.text).toMatch(/元に戻す処理/)
  expect(calls.some(c => c[2] === 'undo')).toBe(true)
  expect((await $.command.run({ command: 'kin', args: 'next 1' } as any)).text).toMatch(/出ていません/)
})

test('v0.7 next: a bare number from the user runs it and drops the prompt; without a list it passes through', async ($, on) => {
  const calls: string[][] = []
  let reached = ''
  on('prompt.submit', (_, e) => ((reached = e.text), { text: e.text }))
  nextHooks(on, NEXT_SCRIPT, calls)
  await START_NEXT($)
  // 一覧が無い時は素通り
  const pass = await $.prompt.submit({ text: '2', asUser: true } as any)
  expect(pass.drop).toBeUndefined()
  expect(reached).toBe('2')

  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  reached = ''
  logs.length = 0
  const r = await $.prompt.submit({ text: ' ２ ', asUser: true } as any)
  expect(r.drop).toBe('次の一手 2 を実行しました')
  expect(reached).toBe('')
  await wait()
  expect(await paneLinks($, 'desktop')).toContain('https://ex.cybozu.com/k/admin/app/12/plugin/config?pluginId=pid')
  expect(await paneAll($, 'desktop')).not.toContain('https://')
  // 数字以外・長い文は素通り
  const words = await $.prompt.submit({ text: '2番をお願い', asUser: true } as any)
  expect(words.drop).toBeUndefined()
  expect(reached).toBe('2番をお願い')
})

test('v0.7 next: the list rides the next prompt as a digest for words replies; the looks line names relay-config', async ($, on) => {
  const calls: string[][] = []
  let seen = ''
  on('prompt.submit', (_, e) => ((seen = (e.context ?? []).join('\n')), { text: e.text, context: e.context }))
  nextHooks(on, NEXT_SCRIPT, calls)
  on('prompt.compose', () => ({ sections: [] }))
  await START_NEXT($)
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/a.js', old_string: 'a', new_string: 'b' })
  await wait()
  await $.prompt.submit({ text: '設定を変えたい', asUser: true } as any)
  expect(seen).toMatch(/次の一手/)
  expect(seen).toMatch(/2 設定を変える/)
  const c = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  const looks = c.sections.find((s: { id: string }) => s.id === 'plugbits-relay:looks')!
  expect(looks.text).toMatch(/RelayConfig\.mount/)
  expect(looks.text).toMatch(/rowsTable/)
  expect(looks.text).toMatch(/51-modern-default/)
})


// ---- v0.8 操作できる画面チェック・試験データ・ビルド段・フォーム変更・次の一手の固定番号 ----
const ALL8 = ['1', '2', '3', '4', '5', '6', '7', '8']

test('v0.8 next: 1-8 always show in order; a gone item is "N (今は無し)" and choosing it says so', async ($, on) => {
  const calls: string[][] = []
  nextHooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs mode': { ok: true, mode: 'prod' } }, calls)
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  await $.command.run({ command: 'kin', args: 'ok' } as any)
  const said = logs.join('\n')
  // 本番: 6(本番に入れる)と 8(試験データ)は無し。番号は動かない
  expect(said).toContain('6 本番に入れる(今は無し)')
  expect(said).toContain('8 試験データを片付ける(今は無し)')
  expect(said).toContain('7 終わる')
  expect(said).toContain('6 本番に入れる(今は無し)')
  const order = ALL8.map(n => said.indexOf(`${n} `))
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(order.every(i => i >= 0)).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'next-6' })).toBeUndefined()
  const off = await ui.findAll({ type: 'Text' })
  expect(off.map((t: { text: string }) => t.text)).toContain('6 本番に入れる(今は無し)')
  expect(await ui.find({ type: 'Button', key: 'next-7' })).toBeDefined()
  await ui.unmount()
  expect((await $.command.run({ command: 'kin', args: 'next 6' } as any)).text).toMatch(/^kin: 6 は今は選べません/)
  expect((await $.command.run({ command: 'kin', args: 'next ８' } as any)).text).toMatch(/^kin: 8 は今は選べません/)
  // 素の番号でも同じ(全角の8も受ける)
  logs.length = 0
  const r = await $.prompt.submit({ text: '８', asUser: true } as any)
  expect(r.drop).toBe('次の一手 8 を実行しました')
  await wait()
  expect(await paneAll($, 'desktop')).toMatch(/8 は今は選べません/)
})

test('v0.8 next: 8 is active only while kin-records list has records; choosing it cleans up that app', async ($, on) => {
  const calls: string[][] = []
  nextHooks(on, { ...NEXT_SCRIPT, 'kin-records.mjs list': { ok: true, appId: '12', count: 3, tags: { t1: 3 } }, 'kin-records.mjs cleanup': { ok: true, appId: '12', deleted: 3, missing: 0, remaining: 0 } }, calls)
  await START_NEXT($)
  const res = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(res).toContain('8 試験データを片付ける')
  expect(logs.join('\n')).toContain('8 試験データを片付ける')
  expect(calls.some(c => c[1]?.endsWith('kin-records.mjs') && c[2] === 'list' && c[3] === '12')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  logs.length = 0
  await ui.press({ key: 'next-8' })
  await wait()
  await ui.unmount()
  const cu = calls.find(c => c[1]?.endsWith('kin-records.mjs') && c[2] === 'cleanup')!
  expect(cu.slice(3)).toEqual(['12'])
  expect(logs.join('\n')).toMatch(/消したレコード: 3 件/)
})

test('v0.8 probe: actions go through a temp file; the digest shows per-action ok/ng, opened record, screen and events count/loads/handlers', async ($, on) => {
  const calls: string[][] = []
  const written: { path: string; text: string }[] = []
  toolHooks(on, written)
  const PROBE_ACT = {
    ok: false,
    appId: '12',
    seconds: 4,
    sheet: '/tmp/a.png',
    sheetPages: ['actions'],
    pages: [{ name: 'actions', consoleErrors: [], pageErrors: [], failedRequests: [], events: [{ type: 'app.record.edit.submit', count: 2, handlers: 1 }], eventOrder: [], loads: 1 }],
    actions: [
      { i: 0, kind: 'open', ok: true, ms: 800, url: 'https://ex.cybozu.com/k/65/show#record=47', recordId: '47' },
      { i: 1, kind: 'click', ok: true, ms: 200, text: 'マスターを整える' },
      { i: 2, kind: 'fill', ok: false, ms: 5000, error: '欄 品番 が見つかりません' },
      { i: 3, kind: 'save', skipped: true },
    ],
    opened: { page: 'detail', recordId: '47', url: 'https://ex.cybozu.com/k/65/show#record=47' },
    screen: { dialog: '統合先を選んでください', text: '', buttons: ['保存', 'キャンセル'], labels: ['品番', '統合先'] },
  }
  fakeTools(on, { ...CONTRACT, 'kin-probe.mjs': PROBE_ACT }, calls)
  await $.session.start(START)
  const acts = [{ open: 'detail', record: 47 }, { click: 'text=マスターを整える' }, { fill: { label: '品番', value: 'ZZ-999' } }, { save: true }]
  const out = await callTool($, 'kin_probe', { appId: '12', pages: ['index'], actions: acts, screenshots: true })
  const pc = calls.find(c => c[1]?.endsWith('kin-probe.mjs'))!
  const ai = pc.indexOf('--actions')
  expect(ai).toBeGreaterThan(0)
  expect(pc.includes('--pages')).toBe(false)
  expect(JSON.parse(written.find(w => w.path === pc[ai + 1])!.text)).toEqual(acts)
  expect(calls.some(c => c[0] === 'rm' && c[2] === pc[ai + 1])).toBe(true)
  expect(out).toMatch(/手順0 open \| OK #47/)
  expect(out).toMatch(/手順2 fill \| NG 欄 品番 が見つかりません/)
  expect(out).toMatch(/開いた画面 \| detail レコード#47 https:\/\/ex\.cybozu\.com\/k\/65\/show#record=47/)
  expect(out).toMatch(/ダイアログ \| 統合先を選んでください/)
  expect(out).toMatch(/ボタン \| 保存 \/ キャンセル/)
  expect(out).toMatch(/発火\/登録 \| 読み込み1回 ・ app\.record\.edit\.submit 発火2・登録1/)
  expect(out).toMatch(/縮小1枚\(actions\): \/tmp\/a\.png/)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/手順1 click ✓/)
  expect(shown).toMatch(/手順2 fill ✗/)
  expect(shown).toMatch(/events: 読み込み1回/)
  // 形の違う手順は呼ぶ前に断る
  expect(await callTool($, 'kin_probe', { appId: '12', actions: [{ fill: { label: 'x' } }] })).toMatch(/bad_input/)
  expect(await callTool($, 'kin_probe', { appId: '12', actions: [{ open: 'detail', click: 'text=x' }] })).toMatch(/bad_input/)
})

test('v0.8 probe: a timeout with a sheet asked says 時間切れ for the sheet; actions get 240 s', async ($, on) => {
  const recs: Rec[] = []
  const waits: number[] = (clock.waits = [])
  toolHooks(on)
  clock.expireAfterMs = 240000
  fakeV4(on, { ...CONTRACT, 'kin-probe.mjs': 'HANG' }, recs)
  await $.session.start(START)
  const p = await callTool($, 'kin_probe', { appId: '12', actions: [{ open: 'index' }], screenshots: true })
  clock.expireAfterMs = -1
  clock.waits = undefined
  expect(p).toMatch(/時間切れ\(240 秒\)/)
  expect(p).toMatch(/縮小1枚は作れませんでした\(時間切れ\)/)
  expect(waits).toContain(240000)
})

test('v0.8 prod: probe write actions, records write/cleanup and form_change are refused (not awaiting); read actions still run', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  on('env.get', { name: 'RELAY_FORM_CHANGE' }, () => ({ value: '1' }))
  fakeTools(on, { ...CONTRACT, 'kin-loop.mjs mode': { ok: true, mode: 'prod' } }, calls)
  await $.session.start(START)
  const probes = () => calls.filter(c => c[1]?.endsWith('kin-probe.mjs')).length
  for (const a of [{ fill: { label: 'a', value: 'b' } }, { select: { label: 'a', value: 'b' } }, { press: 'Enter' }, { save: true }, { click: 'text=x' }]) {
    const r = await callTool($, 'kin_probe', { appId: '12', actions: [{ open: 'detail' }, a] })
    expect(r).toMatch(/prod_denied/)
    expect(r).not.toMatch(/awaiting/)
  }
  expect(probes()).toBe(0)
  expect(await callTool($, 'kin_probe', { appId: '12', actions: [{ open: 'detail' }, { expect: { text: 'x' } }, { wait: 100 }, { read: true }] })).toMatch(/アプリ 12/)
  expect(probes()).toBe(1)

  const w = await callTool($, 'kin_records_write', { appId: '12', rows: [{ title: 'a' }], tag: 't1' })
  const c = await callTool($, 'kin_records_cleanup', { appId: '12' })
  const f = await callTool($, 'kin_form_change', { appId: '12', ops: [{ label: { code: 'title', label: 'x' } }] })
  for (const r of [w, c, f]) {
    expect(r).toMatch(/prod_denied/)
    expect(r).not.toMatch(/awaiting/)
  }
  expect(calls.some(x => x[1]?.endsWith('kin-records.mjs'))).toBe(false)
  expect(calls.some(x => x[2] === 'form-change')).toBe(false)
  expect((await $.command.run({ command: 'kin', args: 'ok' } as any)).text).toMatch(/確認待ちはありません/)
})

test('v0.8 records: write goes through a rows temp file with the tag; cleanup passes the tag; bad input never runs', async ($, on) => {
  const calls: string[][] = []
  const written: { path: string; text: string }[] = []
  toolHooks(on, written)
  fakeTools(on, { ...CONTRACT, 'kin-records.mjs write': { ok: true, mode: 'dev', appId: '12', tag: 't1', ids: ['101', '102'], file: '/x' }, 'kin-records.mjs list': { ok: true, count: 0, tags: {} }, 'kin-records.mjs cleanup': { ok: true, appId: '12', deleted: 2, missing: 0, remaining: 0 } }, calls)
  await $.session.start(START)
  const rows = [{ title: 'a', qty: 1 }, { title: 'b', qty: 2 }]
  const w = JSON.parse(await callTool($, 'kin_records_write', { appId: '12', rows, tag: 't1' }))
  expect(w.ids).toEqual(['101', '102'])
  const wc = calls.find(c => c[1]?.endsWith('kin-records.mjs') && c[2] === 'write')!
  expect(wc.slice(3, 4)).toEqual(['12'])
  expect(wc[4]).toBe('--rows')
  expect(wc.slice(6)).toEqual(['--tag', 't1'])
  expect(JSON.parse(written.find(x => x.path === wc[5])!.text)).toEqual(rows)
  expect(calls.some(c => c[0] === 'rm' && c[2] === wc[5])).toBe(true)
  const cl = JSON.parse(await callTool($, 'kin_records_cleanup', { appId: '12', tag: 't1' }))
  expect(cl.deleted).toBe(2)
  expect(calls.find(c => c[1]?.endsWith('kin-records.mjs') && c[2] === 'cleanup')!.slice(3)).toEqual(['12', '--tag', 't1'])
  const n = calls.filter(c => c[1]?.endsWith('kin-records.mjs')).length
  expect(await callTool($, 'kin_records_write', { appId: '12', rows, tag: 'bad tag!' })).toMatch(/bad_input/)
  expect(await callTool($, 'kin_records_write', { appId: '12', rows: [], tag: 't' })).toMatch(/bad_input/)
  expect(await callTool($, 'kin_records_write', { appId: '12', rows: Array(21).fill({ a: 1 }), tag: 't' })).toMatch(/bad_input/)
  expect(calls.filter(c => c[1]?.endsWith('kin-records.mjs')).length).toBe(n)
})

test('v0.8 build: a failed build stops the deploy and shows the last 20 lines in the pane and the tool result', async ($, on) => {
  const calls: string[][] = []
  const tail = Array.from({ length: 20 }, (_, i) => `out ${i + 1}`).join('\n') + '\nERR boom'
  toolHooks(on)
  fakeTools(on, { ...CONTRACT, 'kin-build.mjs': { ok: false, error: { code: 'build_failed', message: 'コマンドが終了コード 1 で終わりました', tail } } }, calls)
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: '12' } as any)
  const r = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(r).toMatch(/ビルドに失敗/)
  expect(r).toMatch(/ERR boom/)
  expect(r).not.toMatch(/反映しました/)
  expect(deploys(calls).length).toBe(0)
  expect(calls.some(c => c[1]?.endsWith('kin-probe.mjs'))).toBe(false)
  expect(calls.find(c => c[1]?.endsWith('kin-build.mjs'))!.slice(2)).toEqual(['/w/plugins/foo'])
  expect(await paneTexts($, 'terminal')).toMatch(/ERR boom/)
  // 保存の自動反映でも同じ
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/src/a.js', old_string: 'a', new_string: 'b' })
  await wait(700)
  expect(deploys(calls).length).toBe(0)
  expect(await paneTexts($, 'terminal')).toMatch(/ビルド失敗 foo/)
})

test('v0.8 build: a successful build deploys the built dir with the source relay.config.json', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  files['/w/plugins/foo/relay.config.json'] = '{"k":"v","build":{"command":"npm run stage","dir":"plugins/foo-dev"}}'
  fakeTools(on, { ...CONTRACT, 'kin-build.mjs': { ok: true, built: true, dir: '/w/plugins/foo-dev', seconds: 2, tail: '' } }, calls)
  await $.session.start(START)
  const r = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(r).toMatch(/foo をアプリ 12 に反映しました/)
  expect(deploys(calls)[0]?.slice(3)).toEqual(['/w/plugins/foo-dev', '12', '--config', '/w/plugins/foo/relay.config.json'])
  expect(await paneTexts($, 'terminal')).toMatch(/✓ ビルド 2 秒/)
})

test('v0.8 build: saves under another plugin\'s build.dir do not auto-deploy; the source save does', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  on('fs.list', () => ({
    value: [
      { name: 'foo', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'foo-dev', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  files['/w/plugins/foo/relay.config.json'] = JSON.stringify({ build: { command: 'npm run stage:dev', dir: 'plugins/foo-dev' } })
  fakeTools(on, { ...CONTRACT, 'kin-build.mjs': { ok: true, built: true, dir: '/w/plugins/foo-dev', seconds: 1 } }, calls)
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: '12' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo-dev/desktop.js', old_string: 'a', new_string: 'b' })
  await wait(700)
  expect(deploys(calls).length).toBe(0)
  expect(calls.some(c => c[1]?.endsWith('kin-build.mjs'))).toBe(false)
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/src/a.js', old_string: 'a', new_string: 'b' })
  await wait(700)
  expect(deploys(calls).length).toBe(1)
  expect(calls.filter(c => c[1]?.endsWith('kin-build.mjs')).length).toBe(1)
  // 直後の同じプラグインの道具反映は二重にならない(今までどおり)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/src/b.js', old_string: 'a', new_string: 'b' })
  await wait(700)
  expect(deploys(calls).length).toBe(2)
})

test('v0.8 deploy: "65,53" deploys once for both apps (dev), probes each, and shows per-app results; prod is refused', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  const MULTI = { ...DEPLOY_OK, appId: '65', apps: [{ appId: '65', ok: true, steps: [] }, { appId: '53', ok: false, error: { message: 'config 失敗' }, steps: [] }], ok: false }
  fakeTools(on, { ...CONTRACT, 'kin-loop.mjs deploy': { ...MULTI, ok: true, apps: [{ appId: '65', ok: true, steps: [] }, { appId: '53', ok: true, steps: [] }] } }, calls)
  await $.session.start(START)
  const r = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '65,53' })
  expect(deploys(calls).length).toBe(1)
  expect(deploys(calls)[0]?.slice(3)).toEqual(['/w/plugins/foo', '65,53'])
  expect(calls.filter(c => c[1]?.endsWith('kin-probe.mjs')).map(c => c[2])).toEqual(['65', '53'])
  expect(r).toMatch(/アプリ 65, 53 に反映しました/)
  expect(r).toMatch(/- アプリ 65: OK/)
  expect(r).toMatch(/- アプリ 53: OK/)
  expect(calls.filter(c => c[2] === 'mode').map(c => c[3])).toEqual(['65', '53'])
  // appIds の配列でも
  const r2 = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appIds: ['65', '53'] })
  expect(r2).toMatch(/アプリ 65, 53/)
  expect(await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '65,x' })).toMatch(/bad_input/)
})

test('v0.8 deploy: a failed app in a multi deploy is listed; prod in the list refuses everything', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, { ...CONTRACT, 'kin-loop.mjs deploy': { ...DEPLOY_OK, ok: false, appId: '65', apps: [{ appId: '65', ok: true, steps: [] }, { appId: '53', ok: false, error: { message: 'config 失敗' }, steps: [] }] } }, calls)
  await $.session.start(START)
  const r = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '65,53' })
  expect(r).toMatch(/失敗したアプリがあります/)
  expect(r).toMatch(/- アプリ 53: NG config 失敗/)
})

test('v0.8 deploy: multi with a prod app is refused ("本番は1アプリずつ") before anything runs', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  fakeTools(on, { ...CONTRACT, 'kin-loop.mjs mode': { ok: true, mode: 'prod' } }, calls)
  await $.session.start(START)
  const r = await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '65,53' })
  expect(r).toMatch(/prod_denied/)
  expect(r).toMatch(/本番は1アプリずつ/)
  expect(r).not.toMatch(/awaiting/)
  expect(deploys(calls).length).toBe(0)
  expect(calls.some(c => c[1]?.endsWith('kin-build.mjs'))).toBe(false)
})

test('v0.8 form: the pane and digest show lookup, unique, defaultValue and referenceTable', async ($, on) => {
  const calls: string[][] = []
  baseHooks(on)
  const F = {
    ok: true,
    fields: [
      { code: 'part', label: '品番', type: 'SINGLE_LINE_TEXT', unique: true, required: true },
      { code: 'rm', label: '原料', type: 'SINGLE_LINE_TEXT', defaultValue: 'RM-1', lookup: { relatedApp: { app: '7', code: 'rm_master' }, relatedKeyField: 'rm_code', fieldMappings: [{ field: 'rm_name', relatedField: 'name' }] } },
      { code: 'refs', label: '関連', type: 'REFERENCE_TABLE', referenceTable: { relatedApp: { app: '9' }, condition: { field: 'part', relatedField: 'part' }, displayFields: ['qty'] } },
    ],
    plugins: [],
    customize: { desktop: { js: [], css: [] }, mobile: { js: [], css: [] } },
  }
  fakeProcess(on, { 'kin-loop.mjs form': F }, calls)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'kin', args: '12' } as any)
  expect(r.text).toMatch(/\| part \| 品番 \| SINGLE_LINE_TEXT ・ 重複禁止 \|/)
  expect(r.text).toMatch(/ルックアップ: 参照先 アプリ 7\(rm_master\) ・ キー rm_code ・ コピー先 name→rm_name/)
  expect(r.text).toMatch(/既定値 RM-1/)
  expect(r.text).toMatch(/関連レコード: 参照先 アプリ 9 ・ 条件 part=part ・ 表示 qty/)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/part ・ 品番 ・ SINGLE_LINE_TEXT ・ 必須/)
  expect(shown).toMatch(/重複禁止/)
  expect(shown).toMatch(/ルックアップ: 参照先 アプリ 7\(rm_master\)/)
})

test('v0.8 form_change: plan is shown and waits; /kin ok applies the same ops; /kin cancel drops it; bad ops never run', async ($, on) => {
  const calls: string[][] = []
  const written: { path: string; text: string }[] = []
  toolHooks(on, written)
  on('env.get', { name: 'RELAY_FORM_CHANGE' }, () => ({ value: '1' }))
  fakeTools(on, {
    ...CONTRACT,
    'kin-loop.mjs form-change': (args: string[]) =>
      args.includes('--plan')
        ? { ok: true, mode: 'dev', appId: '12', plan: [{ i: 1, op: 'add', code: 'memo', summary: '欄「メモ」(memo)を追加' }, { i: 2, op: 'lookup', code: 'rm', summary: '欄 rm に RM マスターのルックアップを付ける' }], warnings: ['レイアウトの末尾に入ります'] }
        : { ok: true, mode: 'dev', appId: '12', applied: [{ i: 1, op: 'add', code: 'memo', ok: true }, { i: 2, op: 'lookup', code: 'rm', ok: true }], backup: '/x/form-1.json', seconds: 6 },
  }, calls)
  await $.session.start(START)
  const ops = [{ add: { code: 'memo', type: 'SINGLE_LINE_TEXT', label: 'メモ' } }, { lookup: { code: 'rm', relatedApp: '7', relatedKeyField: 'rm_code', fieldMappings: [{ field: 'rm_name', relatedField: 'name' }] } }]
  const r = JSON.parse(await callTool($, 'kin_form_change', { appId: '12', ops }))
  expect(r.status).toBe('awaiting_human_confirmation')
  expect(r.plan).toEqual(['1. 欄「メモ」(memo)を追加', '2. 欄 rm に RM マスターのルックアップを付ける'])
  expect(r.warnings).toEqual(['レイアウトの末尾に入ります'])
  const fc = () => calls.filter(c => c[2] === 'form-change')
  expect(fc().length).toBe(1)
  expect(fc()[0]!.slice(3, 4)).toEqual(['12'])
  expect(fc()[0]!.includes('--plan')).toBe(true)
  expect(JSON.parse(written.find(w => w.path === fc()[0]![5])!.text)).toEqual(ops)
  const shown = await paneTexts($, 'terminal')
  expect(shown).toMatch(/確認待ち: フォームの変更\(アプリ 12\)/)
  expect(shown).toMatch(/欄「メモ」\(memo\)を追加/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'confirm-ok' })).toBeDefined()
  await ui.unmount()
  // 確認が通るまでは何も書かない。もう一度呼んでも道具では通らない
  await callTool($, 'kin_status')
  expect(fc().filter(c => !c.includes('--plan')).length).toBe(0)

  const ok = await $.command.run({ command: 'kin', args: 'ok' } as any)
  expect(ok.text).toMatch(/アプリ 12 のフォームを変更しました/)
  const apply = fc().filter(c => !c.includes('--plan'))
  expect(apply.length).toBe(1)
  expect(apply[0]!.slice(2, 5)).toEqual(['form-change', '12', '--ops'])
  expect(JSON.parse(written.filter(w => w.path === apply[0]![5]).pop()!.text)).toEqual(ops)
  expect(await paneTexts($, 'terminal')).toMatch(/✓ フォームの変更 アプリ 12 6 秒/)
  expect((await $.command.run({ command: 'kin', args: 'ok' } as any)).text).toMatch(/確認待ちはありません/)

  // やめる
  await callTool($, 'kin_form_change', { appId: '12', ops })
  const no = await $.command.run({ command: 'kin', args: 'cancel' } as any)
  expect(no.text).toMatch(/フォームは変えていません/)
  expect(fc().filter(c => !c.includes('--plan')).length).toBe(1)

  // 削除など対象外の形・空は呼ぶ前に断る
  const before = calls.length
  expect(await callTool($, 'kin_form_change', { appId: '12', ops: [{ delete: { code: 'memo' } }] })).toMatch(/bad_input/)
  expect(await callTool($, 'kin_form_change', { appId: '12', ops: [{ lookup: null }] })).toMatch(/bad_input/)
  expect(await callTool($, 'kin_form_change', { appId: '12', ops: [] })).toMatch(/bad_input/)
  expect(calls.length).toBe(before)
})

test('v0.8 form_change: a plan the CLI refuses is returned as the error and nothing waits', async ($, on) => {
  const calls: string[][] = []
  toolHooks(on)
  on('env.get', { name: 'RELAY_FORM_CHANGE' }, () => ({ value: '1' }))
  fakeTools(on, { ...CONTRACT, 'kin-loop.mjs form-change': { ok: false, error: { code: 'bad_ops', message: '欄 memo は既にあります' } } }, calls)
  await $.session.start(START)
  const r = await callTool($, 'kin_form_change', { appId: '12', ops: [{ add: { code: 'memo', type: 'SINGLE_LINE_TEXT', label: 'メモ' } }] })
  expect(r).toMatch(/bad_ops/)
  expect(r).toMatch(/既にあります/)
  expect((await $.command.run({ command: 'kin', args: 'ok' } as any)).text).toMatch(/確認待ちはありません/)
})

test('v0.8 guard: Bash cannot run kin-records write/cleanup or kin-loop form-change; list stays open', async ($, on) => {
  baseHooks(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command } as any)
  for (const c of [
    'node tools/kin-records.mjs write 42 --rows r.json --tag t',
    'node ~/repos/relay/tools/kin-records.mjs cleanup 42',
    'node tools/kin-loop.mjs form-change 42 --ops o.json',
    'node tools/kin-loop.mjs form-change 42 --ops o.json --plan',
  ]) {
    expect((await bash(c)).deny).toMatch(/kin_/)
  }
  expect((await bash('node tools/kin-records.mjs list 42')).deny).toBeUndefined()
  expect((await bash('node tools/kin-build.mjs plugins/x --check')).deny).toBeUndefined()
})

test('v0.8: kin_form_change is not registered and refuses unless RELAY_FORM_CHANGE=1', async ($, on) => {
  const names: string[] = []
  baseHooks(on)
  on('tool.register', (_: unknown, e: { name: string }) => {
    names.push(e.name)
    return { value: { tool: `${T}${e.name}` } }
  })
  await $.session.start(START)
  expect(names).not.toContain('kin_form_change')
  expect(names.length).toBe(13)
})


// ---- v0.9 デスクトップ版の作業台: 帯・鼓動・地図・番号を捨てない ----
const BAND = {
  plugin: 'plugbits-relay',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 } },
} as const
const PROBE_ERR = {
  ok: false,
  appId: '12',
  seconds: 2,
  pages: [{ name: 'index', consoleErrors: [], pageErrors: [{ message: 'TypeError: x is not defined', at: 'at show (https://ex.cybozu.com/k/api/js/desktop.js:3:9)' }], failedRequests: [], events: [], eventOrder: [] }],
}
const PROFILE_FN = (a: string[]) => (a[0] === 'status' ? { ok: true, name: '開発', mode: 'dev', host: 'dev.cybozu.com' } : NEXT_SCRIPT['kin-profile.mjs'])
const fills: string[] = []
function v9Hooks(on: any, script: Script, calls: string[][], surfaces: string[] = ['desktop']) {
  nextHooks(on, script, calls)
  fills.length = 0
  on('session.surfaces', () => ({ value: surfaces }))
  on('prompt.fill', (_: unknown, e: { text: string }) => (fills.push(e.text), { isFilled: true }))
}
async function mountAll($: any, base: any, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ ...base, surface })
  const all = JSON.stringify(await ui.findAll({}))
  return { ui, all }
}

test('v0.9 band: desktop and terminal show conn (dev) · app · last deploy · errors, never the host', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-profile.mjs': PROFILE_FN }, calls)
  await $.session.start(START)
  // 接続前: 案内だけ
  let b = await mountAll($, BAND, 'desktop')
  expect(b.all).toContain('/kin setup で接続設定')
  await b.ui.unmount()
  await $.command.run({ command: 'kin', args: 'status' } as any)
  await $.command.run({ command: 'kin', args: '12' } as any)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  for (const s of ['desktop', 'terminal'] as const) {
    b = await mountAll($, BAND, s)
    // v1.0 見本の帯の作法: ● 接続先・アプリ・最後の反映 HH:MM · N秒。エラーは 1 以上の時だけ
    expect(b.all).toContain('開発')
    expect(b.all).toContain('アプリ 12')
    expect(b.all).toMatch(/最後の反映 \d\d:\d\d · \d+秒/)
    expect(b.all).not.toContain('エラー 0')
    expect(b.all).not.toContain('dev.cybozu.com')
    await b.ui.unmount()
  }
})

test('v0.9 band: a prod deploy waits in the band; [反映] in the band deploys, [やめる] does not', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs mode': { ok: true, mode: 'prod' } }, calls)
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  expect(deploys(calls).length).toBe(0)
  let b = await mountAll($, BAND, 'desktop')
  expect(b.all).toContain('本番に反映待ち')
  await b.ui.press({ key: 'band-cancel' })
  await wait()
  await b.ui.unmount()
  expect(deploys(calls).length).toBe(0)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  b = await mountAll($, BAND, 'terminal')
  await b.ui.press({ key: 'band-ok' })
  await wait()
  await b.ui.unmount()
  expect(deploys(calls).length).toBe(1)
})

test('v0.9 pulse: desktop pane shows the 5 stages with seconds, the error with its code lines, and [直す] fills the prompt', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs deploy': { ...NEXT_DEPLOY, steps: [{ name: 'pack', ok: true, ms: 1200 }, { name: 'upload', ok: true, ms: 800 }, { name: 'install', ok: true, ms: 400 }, { name: 'deploy', ok: true, ms: 3000 }] }, 'kin-probe.mjs': PROBE_ERR, 'kin-profile.mjs': PROFILE_FN }, calls)
  await START_NEXT($)
  files['/w/plugins/foo/manifest.json'] = JSON.stringify({ desktop: { js: ['js/desktop.js'] } })
  files['/w/plugins/foo/js/desktop.js'] = ['// 1', '// 2', '// 3', 'x.show()', '// 5', '// 6', '// 7', '// 8'].join('\n')
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  // v1.0: 5段の鼓動は端末の pane(デスクトップは反映中だけ。終わったらタイルと画面に置き換わる)
  const { ui, all } = await mountAll($, PANE, 'terminal')
  for (const s of ['保存', 'pack 1.2s', 'アップロード 1.2s', '反映 3s', '画面チェック 2s', '合計']) expect(all).toContain(s)
  expect(all).toContain('TypeError: x is not defined')
  expect(all).toContain('x.show()')
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  // 鼓動の側(エラーの見出し・コード)にホストは出さない
  const code = JSON.stringify(await ui.find({ type: 'Code' }))
  expect(code).not.toContain('cybozu')
  expect(all).toContain('未捕捉例外 [index] js/desktop.js:4 TypeError')
  await ui.press({ key: 'pulse-fix-0' })
  await wait()
  await ui.unmount()
  expect(fills.join('\n')).toBe('js/desktop.js:4 の TypeError: x is not defined を直して')
  // デスクトップ: エラーは画面の下に1行・[直す] は同じ動き
  fills.length = 0
  const d = await mountAll($, PANE, 'desktop')
  expect(d.all).toContain('js/desktop.js:4')
  await d.ui.press({ key: 'screen-fix-0' })
  await wait()
  await d.ui.unmount()
  expect(fills.join('\n')).toBe('js/desktop.js:4 の TypeError: x is not defined を直して')
  const b = await mountAll($, BAND, 'desktop')
  expect(b.all).toContain('エラー 1')
  await b.ui.unmount()
})

test('v0.9 next: on desktop a bare number is not dropped — it runs once and the result rides to the model; the pane result area has it too', async ($, on) => {
  const calls: string[][] = []
  let seen: { text: string; context: string } = { text: '', context: '' }
  on('prompt.submit', (_, e) => ((seen = { text: e.text, context: (e.context ?? []).join('\n') }), { text: e.text }))
  v9Hooks(on, NEXT_SCRIPT, calls)
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  logs.length = 0
  const r = await $.prompt.submit({ text: '2', asUser: true } as any)
  expect(r.drop).toBeUndefined()
  expect(seen.text).toBe('2')
  expect(seen.context).toContain('mod が実行済み')
  expect(seen.context).toContain('https://ex.cybozu.com/k/admin/app/12/plugin/config?pluginId=pid')
  expect(await paneLinks($, 'desktop')).toContain('https://ex.cybozu.com/k/admin/app/12/plugin/config?pluginId=pid')
  expect(await paneAll($, 'desktop')).not.toContain('https://')
  // 結果はログ行に流さない(デスクトップ)
  expect(logs.join('\n')).not.toContain('plugin/config')
  // ボタンも結果欄へ
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'next-1' })
  await wait()
  await ui.unmount()
  expect(await paneLinks($, 'desktop')).toContain('https://ex.cybozu.com/k/12/')
  expect(await paneAll($, 'desktop')).not.toContain('https://')
  expect(logs.length).toBe(0)
})

test('v0.9 pane: the status line and the guide line lead; desktop setup has placeholders and never shows the password', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-profile.mjs list': { ok: true, items: [] } }, calls)
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: 'setup' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  // v1.1 頭: pane の題名と二重の「プラグイン作成 mod」は出さない。反映先が未選択なら「はじめに」
  expect(texts.join('\n')).not.toContain('プラグイン作成 mod')
  expect(texts[0]).toContain('はじめに')
  const sub = JSON.stringify(await ui.findAll({ type: 'Input' }))
  expect(sub).toContain('例: example')
  await ui.unmount()
})

test('v0.9.1 desktop: the pane has no field list, the map Svg has a width, plugins/views fold to one line each ([見る] shows names, never IDs), and /kin <appId> answers in one line', async ($, on) => {
  const calls: string[][] = []
  const form = {
    ok: true,
    appName: '製造管理',
    fields: [{ code: 'title', label: 'タイトル', type: 'SINGLE_LINE_TEXT', required: true }, { code: 's', label: '状態', type: 'DROP_DOWN' }],
    layout: [{ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'title', size: { width: '300' } }, { type: 'DROP_DOWN', code: 's', size: { width: '150' } }] }],
    views: [{ name: '一覧1', id: '9001' }, { name: '一覧2', id: '9002' }],
    plugins: [{ name: '見本プラグインA', id: 'aaaabbbbccccddddeeeeffffgggghhhh' }, { name: '見本プラグインB', id: 'hhhhggggffffeeeeddddccccbbbbaaaa' }],
  }
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs form': form, 'kin-profile.mjs': PROFILE_FN }, calls)
  await $.session.start(START)
  const r = await $.command.run({ command: 'kin', args: '12' } as any)
  // 会話の返事は1〜2行。表・プラグイン一覧は出さない
  expect(r.text).toBe('kin: 反映先をアプリ 12 製造管理 にしました。フォームは右の pane にあります')
  await wait()
  const { ui, all } = await mountAll($, PANE, 'desktop')
  // 欄の文字一覧(code ・ label ・ type)は無い
  expect(all).not.toContain('フィールド (code')
  expect(all).not.toContain('title ・ タイトル')
  expect(all).not.toContain('SINGLE_LINE_TEXT')
  // v1.0 地図の Svg は廃止(反映前は Svg なし)
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(all).not.toContain('見本プラグインA')
  expect(all).not.toContain('aaaabbbbccccddddeeeeffffgggghhhh')
  expect(all).not.toContain('9001')
  // 詳細は既定で閉じる。開くとプラグイン・一覧が1行ずつ
  await ui.press({ key: 'detail-toggle' })
  await wait()
  const det = JSON.stringify(await ui.findAll({}))
  expect(det).toContain('付いているプラグイン 2')
  expect(det).toContain('一覧 2')
  expect(det).not.toContain('見本プラグインA')
  await ui.press({ key: 'fold-plugins' })
  await wait()
  const open = JSON.stringify(await ui.findAll({}))
  expect(open).toContain('見本プラグインA')
  expect(open).not.toContain('aaaabbbbccccddddeeeeffffgggghhhh')
  expect(open).not.toContain('一覧1')
  await ui.unmount()
  // ターミナルは今までどおり文字一覧(Svg なし)
  const t = await mountAll($, PANE, 'terminal')
  expect(t.all).toContain('title ・ タイトル ・ SINGLE_LINE_TEXT')
  await t.ui.unmount()
})

test('v0.9.1 terminal: /kin <appId> still answers with the table', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-profile.mjs': PROFILE_FN }, calls, ['terminal'])
  await $.session.start(START)
  const r = await $.command.run({ command: 'kin', args: '12' } as any)
  expect(r.text).toContain('| code | label | type |')
})

// ---- v1.0 プレビューの pane ----
const GATE_PANE = { ...PANE, requestId: 'relay-gate' }
const PROBE_V10 = {
  ok: true,
  appId: '12',
  seconds: 3,
  pages: [
    { name: 'index', url: 'https://ex.example/k/12/', loads: 1, consoleErrors: [], pageErrors: [], failedRequests: [], events: [{ type: 'app.record.index.show', count: 3, handlers: 1 }], eventOrder: [] },
    { name: 'detail', url: 'https://ex.example/k/12/show#record=5', loads: 1, consoleErrors: [], pageErrors: [], failedRequests: [], events: [{ type: 'app.record.detail.show', count: 1, handlers: 1 }], eventOrder: [] },
  ],
  thumbs: [
    { page: 'index', path: '/t/relay-thumbs/index.jpg', width: 540, height: 338, chars: 4 },
    { page: 'detail', path: '/t/relay-thumbs/detail.jpg', width: 540, height: 338, chars: 4 },
  ],
}
const FORM_V10 = {
  ok: true,
  appName: '製造管理',
  fields: [{ code: 'title', label: 'タイトル', type: 'SINGLE_LINE_TEXT', required: true }, { code: 'qty', label: '数量', type: 'NUMBER' }],
  layout: [{ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'title', size: { width: '300' } }, { type: 'NUMBER', code: 'qty', size: { width: '150' } }] }],
  views: [{ name: '一覧A', id: '9001' }],
  plugins: [{ name: '見本プラグインA', id: 'aaaabbbbccccddddeeeeffffgggghhhh' }],
}
const v10Files = () => {
  files['/t/relay-thumbs/index.jpg'] = { base64: 'SU5ERVg=' }
  files['/t/relay-thumbs/detail.jpg'] = { base64: 'REVUQUlM' }
}

test('v1.0 desktop pane: head, 3 tiles, the screen is the only Svg, event rows have bars, the form is chips, no IDs, details folded', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs form': FORM_V10, 'kin-probe.mjs': PROBE_V10, 'kin-profile.mjs': PROFILE_FN }, calls)
  await START_NEXT($)
  v10Files()
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  // 縮小は最初のアプリで1回だけ頼む
  expect(calls.filter(c => c.some(a => a.endsWith('kin-probe.mjs')) && c.includes('--thumbs')).length).toBe(1)
  const { ui, all } = await mountAll($, PANE, 'desktop')
  expect(all).toContain('製造管理')
  for (const k of ['tile-deploy', 'tile-errors', 'tile-last']) expect(await ui.find({ key: k })).toBeDefined()
  const svgs = (await ui.findAll({ type: 'Svg' })) as any[]
  expect(svgs.length).toBe(1)
  expect(svgs[0].props.source).toContain('data:image/jpeg;base64,SU5ERVg=')
  // 画面の切り替え
  await ui.press({ key: 'screen-detail' })
  await wait()
  expect(JSON.stringify(await ui.findAll({ type: 'Svg' }))).toContain('REVUQUlM')
  // イベント: 種類ごとの行と横バー(% の幅)
  const ev = JSON.stringify(await ui.find({ key: 'ev-app.record.index.show' }))
  expect(ev).toContain('発火 3')
  expect(ev).toMatch(/"width":"\d+%"/)
  // フォームはチップ
  expect(await ui.find({ type: 'Button', key: 'fm-title' })).toBeDefined()
  await ui.press({ key: 'fm-title' })
  await wait()
  expect(fills).toContain('title')
  // ID と型名の一覧・プラグイン名は畳んだ詳細の中だけ
  const now = JSON.stringify(await ui.findAll({}))
  expect(now).not.toContain('aaaabbbbccccddddeeeeffffgggghhhh')
  expect(now).not.toContain('9001')
  expect(now).not.toContain('見本プラグインA')
  expect(now).not.toContain('フィールド (code')
  await ui.press({ key: 'detail-toggle' })
  await wait()
  await ui.press({ key: 'fold-plugins' })
  await wait()
  const open = JSON.stringify(await ui.findAll({}))
  expect(open).toContain('見本プラグインA')
  expect(open).not.toContain('aaaabbbbccccddddeeeeffffgggghhhh')
  await ui.unmount()
  // ターミナルは今までどおり文字(Svg なし)
  const t = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await t.find({ type: 'Svg' })).toBeUndefined()
  await t.unmount()
})

test('v1.0 desktop pane: before any deploy the screen says so, and no events are shown', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs form': FORM_V10, 'kin-profile.mjs': PROFILE_FN }, calls)
  await START_NEXT($)
  const { ui, all } = await mountAll($, PANE, 'desktop')
  expect(all).toContain('保存すると、ここに画面が出ます')
  expect(all).not.toContain('イベント')
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('v1.0 gate: a prod deploy opens the small dialog; [反映] there deploys, [やめる] does not', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs mode': { ok: true, mode: 'prod' }, 'kin-loop.mjs backups': { ok: true, appId: '12', backups: [] } }, calls)
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  await wait()
  let g = await mountAll($, GATE_PANE, 'desktop')
  expect(g.all).toContain('本番に反映しますか')
  expect(g.all).toContain('アプリ 12')
  await g.ui.press({ key: 'gate-cancel' })
  await wait()
  await g.ui.unmount()
  expect(deploys(calls).length).toBe(0)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  await wait()
  g = await mountAll($, GATE_PANE, 'desktop')
  await g.ui.press({ key: 'gate-ok' })
  await wait()
  await g.ui.unmount()
  expect(deploys(calls).length).toBe(1)
})

test('v1.0 band: after a deploy the band offers [戻す] and it undoes that app', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs undo': { ok: true, appId: '12', parts: [], restored: true }, 'kin-profile.mjs': PROFILE_FN }, calls)
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  const b = await mountAll($, BAND, 'desktop')
  expect(await b.ui.find({ key: 'band-undo' })).toBeDefined()
  await b.ui.press({ key: 'band-undo' })
  await wait()
  await b.ui.unmount()
  expect(calls.some(c => c.some(a => a.endsWith('kin-loop.mjs')) && c.includes('undo'))).toBe(true)
})

// ---- v1.1 見た目の整え・最初の案内 ----
const PROFILE_V11 = (a: string[]) =>
  a[0] === 'list'
    ? { ok: true, items: [{ id: 'dev', name: '開発', host: 'dev.example.com', kind: 'dev', active: true }, { id: 'stg', name: '検証', host: 'stg.example.com', kind: 'dev', active: false }] }
    : PROFILE_FN(a)
const FORM_PLUGINS = { ...FORM, plugins: [{ id: 'fake-id-1', name: 'カード表示' }, { id: 'fake-id-2', name: '一括更新' }] }

test('v1.1 /kin alone opens the pane with no usage text; unselected pane shows はじめに with 3 cards, no × and no pane title', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs apps': APPS, 'kin-loop.mjs form': FORM_PLUGINS, 'kin-profile.mjs': PROFILE_V11 }, calls)
  await $.session.start(START)
  const r = await $.command.run({ command: 'kin', args: '' } as any)
  expect(r.text ?? '').not.toContain('使い方')
  const { ui, all } = await mountAll($, PANE, 'desktop')
  expect(all).not.toContain('プラグイン作成 mod')
  expect(await ui.find({ key: 'head-close' })).toBeUndefined()
  for (const k of ['start-create', 'start-fix', 'start-conn']) expect(await ui.find({ key: k })).toBeDefined()
  // ① 作る: アプリ一覧 → 選ぶと入力欄に「アプリ 12 に、…を作って」
  await ui.press({ key: 'start-create-go' })
  await wait()
  await ui.press({ key: 'start-app-12' })
  await wait()
  expect(fills.at(-1)).toBe('アプリ 12 に、<やりたいこと> を作って')
  await ui.unmount()
  // ② 直す: アプリ → プラグイン名 → 入力欄(ID は出さない)
  let m = await mountAll($, PANE, 'desktop')
  await m.ui.press({ key: 'start-back' })
  await wait()
  await m.ui.unmount()
  m = await mountAll($, PANE, 'desktop')
  await m.ui.press({ key: 'start-fix-go' })
  await wait()
  await m.ui.press({ key: 'start-app-13' })
  await wait()
  await m.ui.unmount()
  m = await mountAll($, PANE, 'desktop')
  expect(m.all).toContain('カード表示')
  expect(m.all).not.toContain('fake-id-1')
  await m.ui.press({ key: 'start-plugin-0' })
  await wait()
  expect(fills.at(-1)).toBe('アプリ 13 の カード表示 を <直したいこと> に直して')
  await m.ui.unmount()
})

test('v1.1 head conn button lists profiles with [使う] and [接続先を追加] (setup with Inputs on desktop)', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-profile.mjs': PROFILE_V11 }, calls)
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: 'status' } as any)
  let m = await mountAll($, PANE, 'desktop')
  await m.ui.press({ key: 'head-conn' })
  await wait()
  await m.ui.unmount()
  m = await mountAll($, PANE, 'desktop')
  expect(m.all).toContain('検証')
  expect(m.all).toContain('stg.example.com')
  expect(await m.ui.find({ key: 'conn-use-stg' })).toBeDefined()
  expect(await m.ui.find({ key: 'conn-use-dev' })).toBeUndefined()
  await m.ui.press({ key: 'conn-add' })
  await wait()
  await m.ui.unmount()
  m = await mountAll($, PANE, 'desktop')
  expect((await m.ui.findAll({ type: 'Input' })).length).toBeGreaterThan(0)
  await m.ui.unmount()
})

test('v1.1 desktop after a deploy: no (今は無し), no raw URL, result is one card, details fold as ▸ 詳細; compose drops the start section once an app is chosen', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-profile.mjs': PROFILE_FN }, calls)
  on('prompt.compose', () => ({ sections: [] }))
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  await wait()
  let m = await mountAll($, PANE, 'desktop')
  expect(m.all).not.toContain('今は無し')
  await m.ui.press({ key: 'next-2' })
  await wait()
  await m.ui.unmount()
  m = await mountAll($, PANE, 'desktop')
  expect(await m.ui.find({ key: 'result-card' })).toBeDefined()
  const texts = (await m.ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text).join('\n')
  expect(texts).not.toMatch(/https?:\/\//)
  expect(texts).not.toMatch(/次の一手 \d/)
  expect(JSON.stringify(await m.ui.find({ key: 'detail-toggle' }))).toContain('▸ 詳細')
  await m.ui.unmount()
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  expect(r.sections.map((s: { id: string }) => s.id)).not.toContain('plugbits-relay-start')
})

// ---- v1.1.1 反映先を選んだ後も「作る」「直す」 ----
test('v1.1.1 desktop: after choosing an app and before a deploy, the screen section has 2 cards (create / fix n); fix lists plugin names and fills the prompt', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs form': FORM_PLUGINS, 'kin-profile.mjs': PROFILE_FN }, calls)
  await START_NEXT($)
  let m = await mountAll($, PANE, 'desktop')
  expect((await m.ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)).not.toContain('保存すると、ここに画面が出ます')
  expect(await m.ui.find({ key: 'start-conn' })).toBeUndefined()
  expect(await m.ui.find({ key: 'app-create' })).toBeDefined()
  expect(m.all).toContain('付いているプラグインを直す(2)')
  await m.ui.press({ key: 'app-create-go' })
  await wait()
  expect(fills.at(-1)).toBe('アプリ 12 に、<やりたいこと> を作って')
  await m.ui.press({ key: 'app-fix-go' })
  await wait()
  await m.ui.unmount()
  m = await mountAll($, PANE, 'desktop')
  expect(m.all).toContain('一括更新')
  expect(m.all).not.toContain('fake-id-2')
  await m.ui.press({ key: 'start-plugin-1' })
  await wait()
  expect(fills.at(-1)).toBe('アプリ 12 の 一括更新 を <直したいこと> に直して')
  await m.ui.unmount()
})

test('v1.1.1 desktop: after a deploy the same two are small buttons at the head of the next-step row', async ($, on) => {
  const calls: string[][] = []
  v9Hooks(on, { ...NEXT_SCRIPT, 'kin-loop.mjs form': FORM_PLUGINS, 'kin-profile.mjs': PROFILE_FN }, calls)
  await START_NEXT($)
  await callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '12' })
  await wait()
  const m = await mountAll($, PANE, 'desktop')
  expect(await m.ui.find({ key: 'app-create' })).toBeUndefined()
  const row = await m.ui.find({ key: 'next-row' })
  const keys = JSON.stringify(row)
  expect(keys.indexOf('next-create')).toBeGreaterThan(-1)
  expect(keys.indexOf('next-create')).toBeLessThan(keys.indexOf('next-1'))
  expect(keys).toContain('直す(2)')
  await m.ui.press({ key: 'next-create' })
  await wait()
  expect(fills.at(-1)).toBe('アプリ 12 に、<やりたいこと> を作って')
  await m.ui.unmount()
})

test('tools: kin_deploy behind a running save-deploy waits through $.process.run and still reports 反映しました', { timeoutMs: 15000 }, async ($, on) => {
  const calls: string[][] = []
  const runs: string[][] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => (release = r))
  toolHooks(on)
  // 1回目の deploy だけ、テストが放すまで止める。それ以外は偽の道具と同じ
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[] }) {
    calls.push([...e.argv])
    const [, file = '', ...args] = e.argv
    if (file === '--version') {
      yield { stream: 'stdout' as const, text: 'v24.0.0\n' }
      return { value: { code: 0, signal: null } }
    }
    const f = file.split('/').pop() ?? ''
    if (f === 'kin-build.mjs') {
      yield { stream: 'stdout' as const, text: `${JSON.stringify(args.includes('--check') ? { ok: true, build: null } : { ok: true, built: false, dir: args[0] })}\n` }
      return { value: { code: 0, signal: null } }
    }
    if (f === 'kin-loop.mjs' && args[0] === 'deploy' && deploys(calls).length === 1) await gate
    const key = f === 'kin-loop.mjs' ? `${f} ${args[0]}` : f
    yield { stream: 'stdout' as const, text: `${JSON.stringify(CONTRACT[key] ?? { ok: false, error: { message: `no script for ${key}` } })}\n` }
    return { value: { code: 0, signal: null } }
  })
  // 待ち中の $.process.run(1 秒の子)は、少し置いて成功を返す
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    runs.push([...e.argv])
    await wait(50)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.session.start(START)
  await $.command.run({ command: 'kin', args: '42' } as any)

  // 保存の自動反映が走って止まっている間に、道具で同じプラグインを反映
  await $.tool.call({ tool: 'Edit', file_path: '/w/plugins/foo/a.js', old_string: 'a', new_string: 'b' })
  await wait(300)
  expect(deploys(calls).length).toBe(1)
  const pending = callTool($, 'kin_deploy', { pluginDir: 'plugins/foo', appId: '42' })
  await wait(300)
  expect(runs.some(r => r.includes('-e') && r.some(a => a.includes('setTimeout')))).toBe(true)
  release()
  const text = await pending
  expect(text).toContain('反映しました')
  expect(text).not.toContain('tool_failed')
  expect(deploys(calls).length).toBe(2)
})
