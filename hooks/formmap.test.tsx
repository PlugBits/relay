import { expect, test } from 'claude-code/testing'

import { formMapLines, renderFormMap } from './formmap'
import type { FormMapData } from './views'

const FORM: FormMapData = {
  appId: '12',
  appName: '製造管理',
  fields: [
    { code: 'title', label: 'タイトル', type: 'SINGLE_LINE_TEXT', required: true, unique: true },
    { code: 'qty', label: '数量', type: 'NUMBER' },
    {
      code: 'cust',
      label: '顧客',
      type: 'SINGLE_LINE_TEXT',
      lookup: { relatedApp: { app: '7', name: '顧客台帳' }, relatedKeyField: 'id', fieldMappings: [{ field: 'name', relatedField: 'cname' }] } as never,
    },
    { code: 'rows', label: '明細', type: 'SUBTABLE', subtable: [{ code: 'item', label: '品目', type: 'SINGLE_LINE_TEXT' }, { code: 'price', label: '単価', type: 'NUMBER' }] },
    { code: 'memo', label: '備考', type: 'MULTI_LINE_TEXT' },
  ],
  layout: [
    { type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'title', size: { width: '300' } }, { type: 'NUMBER', code: 'qty', size: { width: '150' } }] },
    { type: 'ROW', fields: [{ type: 'LABEL', label: '<b>顧客情報</b>', size: { width: '200' } }, { type: 'SINGLE_LINE_TEXT', code: 'cust', size: { width: '200' } }] },
    { type: 'SUBTABLE', code: 'rows', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'item', size: { width: '200' } }, { type: 'NUMBER', code: 'price', size: { width: '100' } }] },
    { type: 'GROUP', code: 'grp', layout: [{ type: 'ROW', fields: [{ type: 'MULTI_LINE_TEXT', code: 'memo', size: { width: '300' } }] }] },
  ],
}

const many = (n: number): FormMapData => ({
  appId: '1',
  fields: Array.from({ length: n }, (_, i) => ({ code: `f${i}`, label: `欄${i}`, type: 'SINGLE_LINE_TEXT' })),
})

const PROPS = { title: 't', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
type Acts = Partial<Parameters<typeof renderFormMap>[3]>
const mount = async ($: any, on: any, d: FormMapData, surface: 'desktop' | 'terminal' = 'desktop', a: Acts = {}) => {
  on('ui.render', ($: any, e: any) =>
    renderFormMap($.ui.resolve(e), e.surface, d, { onPick: () => {}, open: true, onToggle: () => {}, showAll: false, onShowAll: () => {}, ...a }),
  )
  return $.ui.mount({ plugin: 'plugbits-relay', component: 'Pane', requestId: 'fm', surface, props: PROPS })
}
const btns = async (ui: any, re: RegExp) => ((await ui.findAll({ type: 'Button' })) as { key?: string }[]).filter(b => re.test(b.key ?? ''))
const count = async (ui: any, re: RegExp) => (await btns(ui, re)).length
// Box の直下の子の key(チップ)
const kids = (b: { children: unknown[] }) => b.children.map(c => (c as { props?: { key?: string } })?.props?.key).filter(Boolean) as string[]
const boxes = async (ui: any) => (await ui.findAll({ type: 'Box' })) as { props: Record<string, unknown>; children: unknown[] }[]

test('layout の行どおり: title と qty は同じ行 Box、cust は次の行', async ($, on) => {
  const ui = await mount($, on, FORM)
  const rows = (await boxes(ui)).filter(b => b.props.flexWrap === 'wrap').map(kids)
  expect(rows[0]).toEqual(['fm-title', 'fm-qty'])
  expect(rows[1]).toContain('fm-cust')
  expect(rows[1]).not.toContain('fm-title')
  expect(await ui.find({ type: 'Text', text: /顧客情報/ })).toBeTruthy()
  await ui.unmount()
})

test('サブテーブルは枠の Box に表題と列、グループは見出し', async ($, on) => {
  const ui = await mount($, on, FORM)
  const round = (await boxes(ui)).filter(b => b.props.borderStyle === 'round')
  expect(round).toHaveLength(1)
  expect(round[0].props.borderDimColor).toBe(true)
  const inner = round[0].children.filter(c => (c as { type?: string })?.type === 'Box') as { children: unknown[] }[]
  expect(kids(inner[0])).toEqual(['fm-item', 'fm-price'])
  expect(await ui.find({ type: 'Text', text: /▦ 明細/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /▾ grp/ })).toBeTruthy()
  await ui.unmount()
})

test('チップを押すと onPick にコード、必須は * と型名', async ($, on) => {
  const got: string[] = []
  const ui = await mount($, on, FORM, 'desktop', { onPick: c => got.push(c) })
  const title = await ui.find({ type: 'Button', key: 'fm-title' })
  expect(title.text).toContain('タイトル')
  expect(title.text).toContain('文字列*')
  expect((await ui.find({ type: 'Button', key: 'fm-qty' })).text).toContain('数値')
  expect((await ui.find({ type: 'Button', key: 'fm-qty' })).text).not.toContain('*')
  expect((await ui.find({ type: 'Button', key: 'fm-cust' })).text).toContain('ルックアップ')
  await ui.press({ plugin: 'test', key: 'fm-title' })
  expect(got).toEqual(['title'])
  await ui.unmount()
})

test('畳むと折りたたみ行だけ(▸ フォーム)', async ($, on) => {
  const ui = await mount($, on, FORM, 'desktop', { open: false })
  expect((await ui.find({ type: 'Button', key: 'form-toggle' })).text).toContain('▸ フォーム')
  expect(await count(ui, /^fm-/)).toBe(0)
  await ui.unmount()
})

test('開いていれば折りたたみ行は ▾ フォーム、押すと onToggle', async ($, on) => {
  let n = 0
  const ui = await mount($, on, FORM, 'desktop', { onToggle: () => { n++ } })
  expect((await ui.find({ type: 'Button', key: 'form-toggle' })).text).toContain('▾ フォーム')
  await ui.press({ plugin: 'test', key: 'form-toggle' })
  expect(n).toBe(1)
  await ui.unmount()
})

test('80 欄で打ち切って「他 n 欄」と form-all', async ($, on) => {
  const ui = await mount($, on, many(100))
  expect(await count(ui, /^fm-f/)).toBe(80)
  expect(await ui.find({ type: 'Text', text: /他 20 欄/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'form-all' })).toBeTruthy()
  await ui.unmount()
})

test('showAll なら全欄で form-all は無い', async ($, on) => {
  const ui = await mount($, on, many(100), 'desktop', { showAll: true })
  expect(await count(ui, /^fm-f/)).toBe(100)
  expect(await ui.find({ type: 'Button', key: 'form-all' })).toBeFalsy()
  await ui.unmount()
})

test('layout が無ければ欄ごとのチップ(折り返す行)', async ($, on) => {
  const ui = await mount($, on, { ...FORM, layout: undefined })
  expect(await count(ui, /^fm-/)).toBe(6)
  await ui.unmount()
})

test('デスクトップに Svg は無い', async ($, on) => {
  const ui = await mount($, on, FORM)
  expect(await ui.find({ type: 'Svg' })).toBeFalsy()
  await ui.unmount()
})

test('ターミナルは文字の地図だけ(ボタンなし)', async ($, on) => {
  const ui = await mount($, on, FORM, 'terminal')
  expect((await ui.find({ type: 'Text', text: /\[タイトル title 文字列\*\] \[数量 qty 数値\]/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /デスクトップ版/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button' })).toBeFalsy()
  await ui.unmount()
})

test('formMapLines は 80 欄で切る', () => {
  const r = formMapLines(many(100))
  expect(r.shown).toBe(80)
  expect(r.cut).toBe(20)
})
