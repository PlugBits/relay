import { expect, test } from 'claude-code/testing'

import { mdNextCleanup, mdNextConfig, mdNextPack, mdNextProd, mdNextShot, mdNextUrls, NEXT_CREATE } from './format'
import type { NextState } from './format'
import { renderResultCard, resultCard } from './result'

const O = 'https://example.cybozu.com'
const S: NextState = { appId: '12', name: 'demo', dir: '/x', pluginId: 'abcdef', origin: O, mode: 'dev', shot: true, rec: '3' }
const NOORIGIN: NextState = { ...S, origin: '' }

const CASES: [string, number, string, string[]][] = [
  ['urls', 1, mdNextUrls(S), [`${O}/k/12/`, `${O}/k/12/show#record=3`]],
  ['config', 2, mdNextConfig(S), [`${O}/k/admin/app/12/plugin/config?pluginId=abcdef`]],
  ['shot', 3, mdNextShot('/tmp/a/shot.png', ''), []],
  ['shot-fail', 3, mdNextShot(null, 'timeout'), []],
  ['create', 4, NEXT_CREATE, []],
  ['prod', 6, mdNextProd([{ id: 'p1', name: 'prod', host: 'x.cybozu.com', kind: 'prod' }], '9'), []],
  ['prod-none', 6, mdNextProd([], '9'), []],
  ['pack', 7, mdNextPack({ ok: true, file: '/tmp/out/demo.zip', bytes: 10, version: '1.0.0' } as any), []],
  ['pack-fail', 7, mdNextPack({ ok: false, error: { message: 'no' } } as any), []],
  ['cleanup', 8, mdNextCleanup({ ok: true, deleted: [1, 2], missing: [] } as any, {} as any), []],
  ['urls-nohost', 1, mdNextUrls(NOORIGIN), []],
  ['config-nohost', 2, mdNextConfig(NOORIGIN), []],
]

test('resultCard: line/note に URL・パスが無く、links の href が正しい', () => {
  for (const [name, n, md, hrefs] of CASES) {
    const c = resultCard(n, md)
    expect(`${name}:${c.line}`).not.toContain('http')
    expect(`${name}:${c.line}`).not.toContain('/tmp')
    expect(c.line.length).toBeLessThanOrEqual(30)
    if (c.note) {
      expect(c.note).not.toContain('http')
      expect(c.note).not.toContain('/tmp')
      expect(c.note.length).toBeLessThanOrEqual(40)
    }
    expect(c.links.map(l => l.href)).toEqual(hrefs)
  }
  expect(resultCard(1, mdNextUrls(S)).links[0].label).toBe('一覧を開く ↗')
  expect(resultCard(2, mdNextConfig(S)).links[0].label).toBe('設定画面を開く ↗')
  expect(resultCard(1, mdNextUrls(S)).line).toBe('画面を開けます')
})

test('renderResultCard: 画面の Text に https:// が出ず、Link は href を持つ', async ($, on) => {
  on('ui.render', ($: any, e: any) => renderResultCard($.ui.resolve(e), e.surface, resultCard(1, mdNextUrls(S))))
  const props = { title: 't', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }
  const ui = await $.ui.mount({ plugin: 'plugbits-relay', component: 'Pane', requestId: 'rc', surface: 'desktop', props })
  expect(await ui.find({ type: 'Box', key: 'result-card' })).toBeTruthy()
  expect(await ui.find({ type: 'Link', text: /一覧を開く/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /https:\/\// })).toBeFalsy()
  await ui.unmount()
})
