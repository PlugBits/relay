import { expect, test } from 'claude-code/testing'

import { applyBuild, applyDeploy, applyProbe, attachSnippets, collectErrors, failPulse, fixPromptText, initPulse, renderPulse, snippetDiff } from './pulse'

const HOST = 'example.cybozu.com'
const st = (p: any, k: string) => p.stages.find((s: any) => s.key === k)
const dep = (over: any[] = []) => ({
  ok: true,
  seconds: 5,
  steps: [
    { name: 'pack', ok: true, ms: 1200 },
    { name: 'backup', ok: true, ms: 300 },
    { name: 'upload', ok: true, ms: 800 },
    { name: 'install', ok: true, ms: 150 },
    { name: 'app-plugins', ok: true, ms: 100 },
    { name: 'config', ok: true, ms: 100 },
    { name: 'deploy', ok: true, ms: 2000 },
    ...over,
  ],
})
const probe = (extra: any = {}) => ({
  appId: '12',
  json: {
    ok: true,
    seconds: 3.2,
    pages: [
      {
        name: 'index',
        consoleErrors: [{ text: `Failed https://${HOST}/k/api/x?a=1 boom`, location: `https://${HOST}/k/js/desktop.js?v=1:3` }],
        pageErrors: [{ message: 'ReferenceError: foo', at: `at run (https://${HOST}/k/js/desktop.js:5:9)` }],
      },
    ],
    ...extra,
  },
})

test('stages follow build and deploy', () => {
  let p = initPulse('sample', '12', 1000)
  expect(p.stages.map(s => s.key)).toEqual(['save', 'pack', 'upload', 'apply', 'check'])
  expect(st(p, 'save').status).toBe('run')
  p = applyBuild(p, { ok: true, built: true, seconds: 0.44 })
  expect(st(p, 'save')).toMatchObject({ status: 'ok', seconds: 0.4, note: 'ビルド' })
  expect(st(p, 'pack').status).toBe('run')
  p = applyDeploy(p, dep())
  expect(st(p, 'pack')).toMatchObject({ status: 'ok', seconds: 1.2 })
  expect(st(p, 'upload')).toMatchObject({ status: 'ok', seconds: 1.3 })
  expect(st(p, 'apply')).toMatchObject({ status: 'ok', seconds: 2.2 })
  expect(st(p, 'check').status).toBe('run')
})

test('build failure skips the rest', () => {
  const p = applyBuild(initPulse('s', '1', 0), { ok: false })
  expect(p.stages.map(s => s.status)).toEqual(['err', 'skip', 'skip', 'skip', 'skip'])
})

test('deploy failure mid-steps', () => {
  let p = applyBuild(initPulse('s', '1', 0), { ok: true })
  expect(st(p, 'save').seconds).toBeUndefined()
  const d = dep()
  d.ok = false
  d.steps = d.steps.slice(0, 4)
  d.steps[3] = { name: 'install', ok: false, ms: 50 }
  p = applyDeploy(p, d)
  expect(p.stages.map(s => s.status)).toEqual(['ok', 'ok', 'err', 'skip', 'skip'])
  expect(applyDeploy(applyBuild(initPulse('s', '1', 0), { ok: true }), null).stages.map(s => s.status)).toEqual(['ok', 'err', 'skip', 'skip', 'skip'])
})

test('errors are extracted without any host', () => {
  const errs = collectErrors([probe()])
  expect(errs.length).toBe(2)
  expect(errs[0]).toMatchObject({ kind: 'console', page: 'index', line: 3 })
  // pageerror の stack は 0 始まり → +1
  expect(errs[1]).toMatchObject({ kind: 'pageerror', line: 6 })
  expect(errs[0].message).toBe('Failed boom')
  expect(JSON.stringify(errs)).not.toContain('cybozu')
  expect(JSON.stringify(errs)).not.toContain('https')
  const many = collectErrors([{ appId: '1', json: { pages: [{ name: 'a', consoleErrors: Array.from({ length: 30 }, (_, i) => ({ text: `e${i}` })) }] } }])
  expect(many.length).toBe(10)
})

test('probe result finishes the pulse', () => {
  let p = applyDeploy(applyBuild(initPulse('s', '1', 1000), { ok: true }), dep())
  const bad = applyProbe(p, [probe()], 6500)
  expect(st(bad, 'check')).toMatchObject({ status: 'err', seconds: 3.2 })
  expect(bad.finishedAt).toBe(6500)
  expect(bad.totalSeconds).toBe(5.5)
  expect(JSON.stringify(bad)).not.toContain('cybozu')
  const good = applyProbe(p, [{ appId: '1', json: { ok: true, seconds: 1, pages: [] } }], 3000)
  expect(st(good, 'check').status).toBe('ok')
  expect(good.errors).toEqual([])
  expect(st(applyProbe(p, [{ appId: '1', json: null }], 3000), 'check').status).toBe('err')
  const f = failPulse(p, 2000, `boom https://${HOST}/x`)
  expect(st(f, 'check')).toMatchObject({ status: 'err', note: 'boom' })
  expect(f.finishedAt).toBe(2000)
})

const SRC = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n') + '\n'
const read = async (rel: string) => (rel === 'js/desktop.js' ? SRC : null)
const mk = (line: number | undefined, extra: any = {}) => ({ kind: 'console' as const, message: 'm', line, ...extra })

test('snippets: middle, edges, guessed', async () => {
  const nm = (e: any, n: string) => Object.defineProperty(e, '_name', { value: n, enumerable: false })
  const [mid, first, last, none, out] = await attachSnippets(
    [nm(mk(5), 'desktop.js'), nm(mk(1), 'desktop.js'), nm(mk(10), 'desktop.js'), nm(mk(5), 'other.js'), nm(mk(99), 'desktop.js')],
    ['js/desktop.js', 'https://cdn.example.com/lib.js'],
    read,
  )
  expect(mid.file).toBe('js/desktop.js')
  expect(mid.snippet).toEqual({ startLine: 2, source: 'l2\nl3\nl4\nl5\nl6\nl7\nl8', language: 'javascript' })
  expect(first.snippet).toMatchObject({ startLine: 1, source: 'l1\nl2\nl3\nl4' })
  expect(last.snippet).toMatchObject({ startLine: 7, source: 'l7\nl8\nl9\nl10' })
  expect(none.file).toBeUndefined()
  expect(out.file).toBe('js/desktop.js')
  expect(out.snippet).toBeUndefined()
  const [g] = await attachSnippets([mk(4)], ['js/desktop.js'], read)
  expect(g).toMatchObject({ file: 'js/desktop.js', guessed: true })
  const [two] = await attachSnippets([mk(4)], ['js/desktop.js', 'js/b.js'], read)
  expect(two.file).toBeUndefined()
  const [http] = await attachSnippets([mk(4)], ['https://cdn.example.com/a.js'], read)
  expect(http.file).toBeUndefined()
})

test('collect then attach keeps the basename link', async () => {
  const errs = await attachSnippets(collectErrors([probe()]), ['js/desktop.js'], read)
  expect(errs[0]).toMatchObject({ file: 'js/desktop.js', line: 3 })
  expect(errs[0].guessed).toBeUndefined()
  expect(JSON.stringify(errs)).not.toContain('cybozu')
})

test('fix prompt and diff hunk', () => {
  expect(fixPromptText({ kind: 'console', message: 'x is not defined', file: 'js/desktop.js', line: 7 })).toBe('js/desktop.js:7 の x is not defined を直して')
  expect(fixPromptText({ kind: 'console', message: 'boom' })).toBe('boom を直して')
  const d = snippetDiff({ kind: 'console', message: 'm', line: 5, snippet: { startLine: 2, source: 'a\nb\nc\nd\ne\nf\ng' } })
  expect(d).toBe('@@ -2,7 +2,6 @@\n a\n b\n c\n-d\n e\n f\n g')
})

test('renderPulse draws on every surface', async ($, on) => {
  const p = applyProbe(applyDeploy(applyBuild(initPulse('s', '1', 0), { ok: true }), dep()), [probe()], 4000)
  p.errors = await attachSnippets(p.errors, ['js/desktop.js'], read)
  p.result = { title: '次の一手', md: '- a' }
  let fixed = ''
  on('ui.render', ($, e) => renderPulse($.ui.resolve(e), e.surface, p, er => { fixed = er.message }))
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'x', component: 'Pane', requestId: 'p', surface, props: { title: 't', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as any)
    expect(await ui.find({ type: 'Text', text: /合計 4秒/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', text: /直す/ })).toBeTruthy()
    await ui.unmount()
  }
  expect(fixed).toBe('')
})

test('real kintone shape: plugin JS comes from download.do (no file name) → guessed from the single manifest JS, 0-based line fixed', async () => {
  const probe = { ok: false, pages: [{ name: 'index', consoleErrors: [], pageErrors: [{ message: 'Uncaught ReferenceError: notDefinedForRelayCheck is not defined', at: 'at <anonymous> (https://example.cybozu.com/k/api/plugin/content/download.do?pluginId=abc&type=DESKTOP_JS&contentId=1:4:4)' }] }] }
  const src = ['(function () {', "  'use strict';", '  kintone.events.on("x", function (e) {', '    // c', '    notDefinedForRelayCheck();', '    return e;', '  });', '})();'].join('\n')
  const errs = await attachSnippets(collectErrors([{ appId: '1', json: probe }]), ['js/desktop.js'], async rel => (rel === 'js/desktop.js' ? src : null))
  expect(errs[0]).toMatchObject({ file: 'js/desktop.js', line: 5, guessed: true })
  expect(errs[0].snippet?.source).toContain('notDefinedForRelayCheck();')
  expect(JSON.stringify(errs)).not.toContain('download.do')
  expect(JSON.stringify(errs)).not.toContain('example.cybozu.com')
})
