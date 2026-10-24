import { expect, test } from 'claude-code/testing'

import { eventTone, renderEvents, shortEventName } from './events'

const rows = [
  { type: 'app.record.index.show', count: 8, handlers: 2 },
  { type: 'app.record.detail.show', count: 4, handlers: 1 },
  { type: 'app.record.edit.submit', count: 1, handlers: 1 },
  { type: 'portal.show', count: 0, handlers: 1 },
]

// 文字列コンポーネントで木をそのまま見る
const fake: any = { Box: 'Box', Text: 'Text', Button: 'Button' }
const bars = (v: any): any[] => {
  const out: any[] = []
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(visit)
    if (n.props?.width !== undefined) out.push(n.props)
    visit(n.children)
  }
  visit(renderEvents(fake, 'desktop', v))
  return out
}

test('eventTone by type', () => {
  expect(eventTone('app.record.index.show')).toBe('suggestion')
  expect(eventTone('app.record.index.edit.change.x')).toBe('suggestion')
  expect(eventTone('app.record.detail.show')).toBe('success')
  expect(eventTone('app.record.create.submit')).toBe('warning')
  expect(eventTone('app.record.edit.show')).toBe('warning')
  expect(eventTone('portal.show')).toBe('inactive')
})

test('null and empty draw nothing', () => {
  expect(renderEvents(fake, 'desktop', null)).toBeNull()
  expect(renderEvents(fake, 'desktop', { rows: [], loads: 3 })).toBeNull()
})

test('bar widths are proportional and coloured; zero count has no inner bar', () => {
  const b = bars({ rows, loads: 7 })
  expect(b.filter(x => x.backgroundColor === 'subtle')).toHaveLength(3)
  expect(b.filter(x => x.backgroundColor !== 'subtle').map(x => [x.width, x.backgroundColor])).toEqual([
    ['100%', 'suggestion'],
    ['50%', 'success'],
    ['13%', 'warning'],
  ])
})

test('tiny count gets at least 2%', () => {
  const b = bars({ rows: [{ type: 'a.b', count: 1000, handlers: 1 }, { type: 'app.record.detail.show', count: 1, handlers: 1 }], loads: 1 })
  expect(b.filter(x => x.backgroundColor === 'success')[0].width).toBe('2%')
})

test('shortEventName', () => {
  expect(shortEventName('app.record.index.show')).toBe('index.show')
  expect(shortEventName('mobile.app.record.index.show')).toBe('mobile index.show')
  expect(shortEventName('mobile.space.portal.show')).toBe('mobile portal.show')
  expect(shortEventName('space.portal.show')).toBe('portal.show')
  expect(shortEventName('portal.show')).toBe('portal.show')
})

test('sorted by count desc, 5 rows then ev-more fold; showAll shows all', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ type: `app.record.index.t${i}`, count: i + 1, handlers: 1 }))
  const s = JSON.stringify(renderEvents(fake, 'desktop', { rows: many, loads: 2 }, { onShowAll: () => {} }))
  expect(s).not.toContain('Svg')
  expect(s).toContain('ev-more')
  expect(s).toContain('他 3 件')
  expect(s.indexOf('ev-app.record.index.t7')).toBeLessThan(s.indexOf('ev-app.record.index.t6'))
  expect(s).not.toContain('ev-app.record.index.t2"')
  const all = JSON.stringify(renderEvents(fake, 'desktop', { rows: many, loads: 2 }, { showAll: true, onShowAll: () => {} }))
  expect(all).toContain('ev-app.record.index.t0')
})

test('count 0 row has no bar and dim name', () => {
  const t: any = renderEvents(fake, 'desktop', { rows: [{ type: 'portal.show', count: 0, handlers: 1 }], loads: 1 })
  const s = JSON.stringify(t)
  expect(s).not.toContain('subtle')
  expect(s).toContain('"dimColor":true')
})

test('renders on every surface incl. terminal', async ($, on) => {
  on('ui.render', ($, e) => renderEvents($.ui.resolve(e), e.surface, { rows, loads: 7 }))
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'x', component: 'Pane', requestId: 'p', surface, props: { title: 't', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as any)
    expect(await ui.find({ type: 'Text', text: /読み込み 7回/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /発火 8 · 登録 2/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /detail\.show · 登録|app\.record\.detail\.show/ })).toBeTruthy()
    await ui.unmount()
  }
})
