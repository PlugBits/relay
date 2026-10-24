import { expect, test } from 'claude-code/testing'

import { gateLines, renderGate } from './gate'
import { TONE_COLOR } from './views'

const kinds = ['deploy', 'undo', 'customize', 'use', 'form'] as const
const OK = { deploy: '反映', undo: '戻す', customize: '反映', use: '切り替える', form: '実行' }
const base = { appId: '12', appName: '見積', name: 'sample', version: '1.2', backupAt: new Date(2026, 9, 24, 9, 5).getTime(), plan: ['a', 'b', 'c'], profileName: 'prod' }

test('gateLines: okLabel and at most 3 lines per kind', () => {
  for (const kind of kinds) {
    const v = gateLines({ ...base, kind })
    expect(v.okLabel).toBe(OK[kind])
    expect(v.lines.length).toBeGreaterThan(0)
    expect(v.lines.length).toBeLessThanOrEqual(3)
  }
  expect(gateLines({ ...base, kind: 'deploy' }).lines).toEqual(['プラグイン sample 版 1.2', '対象 アプリ 12 見積', '直前の控え 09:05'])
  expect(gateLines({ appId: '1', kind: 'deploy', name: 'x', backupAt: null }).lines[2]).toContain('なし')
  expect(gateLines({ ...base, kind: 'undo' }).lines[1]).toBe('戻す先 控え 09:05')
  expect(gateLines({ ...base, kind: 'form' }).lines.slice(1)).toEqual(['a', 'b'])
})

test('renderGate: buttons call actions, pill uses prod tone, no Svg', async ($, on) => {
  let ok = 0
  let cancel = 0
  const v = gateLines({ ...base, kind: 'deploy' })
  on('ui.render', ($, e) => renderGate($.ui.resolve(e), e.surface, v, { onOk: () => ok++, onCancel: () => cancel++ }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'x', component: 'Pane', requestId: 'g', surface, props: { title: 't', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 9 }, view: {} } } as any)
    const pill = await ui.find({ type: 'Text', text: /^本番$/ })
    expect(pill).toBeTruthy()
    expect(JSON.stringify(pill)).toContain(TONE_COLOR.prod)
    expect(await ui.find({ type: 'Svg' })).toBeFalsy()
    await ui.press({ plugin: 'test', key: 'gate-ok' })
    await ui.press({ plugin: 'test', key: 'gate-cancel' })
    await ui.unmount()
  }
  expect(ok).toBe(2)
  expect(cancel).toBe(2)
})
