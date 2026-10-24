import { expect, test } from 'claude-code/testing'

import { createPrompt, fixPrompt, renderStart, START_COMPOSE } from './start'
import type { StartActions, StartStep } from './start'

const apps = [{ id: '42', name: 'サンプルA' }, { id: '43', name: 'サンプルB' }, { id: '44', name: 'サンプルC' }]

function setup(v: StartStep) {
  const calls: string[] = []
  const a: StartActions = {
    onCreate: () => calls.push('create'),
    onFix: () => calls.push('fix'),
    onConn: () => calls.push('conn'),
    onBack: () => calls.push('back'),
    onPickCreateApp: id => calls.push(`pc:${id}`),
    onPickFixApp: id => calls.push(`pf:${id}`),
    onPickPlugin: n => calls.push(`pp:${n}`),
  }
  return { calls, a, v }
}

const mountProps = { plugin: 'x', component: 'Pane', requestId: 's', props: { title: 't', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 9 }, view: {} } }

test('menu: 3 cards, go buttons call actions', async ($, on) => {
  const { calls, a } = setup({ step: 'menu' })
  on('ui.render', ($, e) => renderStart($.ui.resolve(e), e.surface, { step: 'menu' }, a))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...mountProps, surface } as any)
    for (const k of ['start-create', 'start-fix', 'start-conn']) expect(await ui.find({ key: k })).toBeTruthy()
    for (const k of ['start-create-go', 'start-fix-go', 'start-conn-go']) await ui.press({ plugin: 'test', key: k })
    await ui.unmount()
  }
  expect(calls).toEqual(['create', 'fix', 'conn', 'create', 'fix', 'conn'])
})

test('create: app buttons call onPickCreateApp, fix calls onPickFixApp, back', async ($, on) => {
  const c = setup({ step: 'create', apps })
  const f = setup({ step: 'fix', apps })
  let cur = c
  on('ui.render', ($, e) => renderStart($.ui.resolve(e), e.surface, cur.v, cur.a))
  const ui = await $.ui.mount({ ...mountProps, surface: 'terminal' } as any)
  await ui.press({ plugin: 'test', key: 'start-app-42' })
  await ui.press({ plugin: 'test', key: 'start-back' })
  await ui.unmount()
  expect(c.calls).toEqual(['pc:42', 'back'])
  cur = f
  const ui2 = await $.ui.mount({ ...mountProps, requestId: 's2', surface: 'terminal' } as any)
  await ui2.press({ plugin: 'test', key: 'start-app-43' })
  await ui2.unmount()
  expect(f.calls).toEqual(['pf:43'])
})

test('fix-plugin: empty shows start-fix-create; plugins list', async ($, on) => {
  const e1 = setup({ step: 'fix-plugin', appId: '42', appName: 'サンプルA', plugins: [] })
  const l = setup({ step: 'fix-plugin', appId: '42', plugins: ['alpha', 'beta'] })
  let cur = e1
  on('ui.render', ($, e) => renderStart($.ui.resolve(e), e.surface, cur.v, cur.a))
  const ui = await $.ui.mount({ ...mountProps, surface: 'desktop' } as any)
  await ui.press({ plugin: 'test', key: 'start-fix-create' })
  await ui.unmount()
  expect(e1.calls).toEqual(['pc:42'])
  cur = l
  const ui2 = await $.ui.mount({ ...mountProps, requestId: 's3', surface: 'terminal' } as any)
  await ui2.press({ plugin: 'test', key: 'start-plugin-1' })
  await ui2.unmount()
  expect(l.calls).toEqual(['pp:beta'])
})

test('prompts and compose section', () => {
  expect(createPrompt('42')).toBe('アプリ 42 に、<やりたいこと> を作って')
  expect(fixPrompt('42', 'alpha')).toBe('アプリ 42 の alpha を <直したいこと> に直して')
  expect(START_COMPOSE.id).toBe('plugbits-relay-start')
  expect(START_COMPOSE.text).toContain('新しくプラグインを作る')
})
