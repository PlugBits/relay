import { expect, test } from 'claude-code/testing'

import { renderScreen, screenSvg } from './screen'
import type { ScreenShot, ScreenView } from './views'

const shot = (page: any, b64 = 'QUJD'): ScreenShot => ({ page, width: 540, height: 338, base64: b64, url: 'https://example.invalid/k/1/' })
const VIEW: ScreenView = {
  hasDeploy: true,
  shots: [shot('index'), shot('detail')],
  selected: 'index',
  errors: [{ kind: 'pageerror', message: 'ReferenceError: foo\nat x', page: 'index', file: 'js/desktop.js', line: 5, guessed: true }],
  note: '設定は撮っていません',
}
const PROPS = { title: 't', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }

const mount = async ($: any, on: any, v: ScreenView, surface = 'desktop', acts: any = {}) => {
  on('ui.render', ($: any, e: any) => renderScreen($.ui.resolve(e), e.surface, v, { onSelect: () => {}, onFix: () => {}, ...acts }))
  return $.ui.mount({ plugin: 'plugbits-relay', component: 'Pane', requestId: 'sc', surface, props: PROPS })
}

test('screenSvg: 1:1 で JPEG を埋め、上限内。大きすぎれば null', () => {
  const s = screenSvg(shot('index'))!
  expect(s.length).toBeLessThanOrEqual(131072)
  expect(s).toContain('data:image/jpeg;base64,QUJD')
  expect(s).toContain('viewBox="0 0 540 338"')
  expect(screenSvg(shot('index', 'A'.repeat(131072)))).toBeNull()
})

test('Svg と Link、選択中が primary、写真の無い画面はボタンにならない', async ($, on) => {
  const ui = await mount($, on, VIEW)
  const svg = (await ui.find({ type: 'Svg' })) as any
  expect(svg).toBeTruthy()
  expect(svg.props.source.length).toBeLessThanOrEqual(131072)
  expect(svg.props.source).toContain('data:image/jpeg')
  expect(await ui.find({ type: 'Link', text: /kintone で開く/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'screen-index' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'screen-detail' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'screen-config' })).toBeFalsy()
  expect(((await ui.find({ type: 'Button', key: 'screen-index' })) as any).props.variant).toBe('primary')
  expect(((await ui.find({ type: 'Button', key: 'screen-detail' })) as any).props.variant).not.toBe('primary')
  await ui.unmount()
})

test('大きすぎる画像は Svg なし・Link だけ', async ($, on) => {
  const ui = await mount($, on, { ...VIEW, shots: [shot('index', 'A'.repeat(131072))] })
  expect(await ui.find({ type: 'Svg' })).toBeFalsy()
  expect(await ui.find({ type: 'Link', text: /kintone で開く/ })).toBeTruthy()
  await ui.unmount()
})

test('反映がまだなら案内の1行だけ', async ($, on) => {
  const ui = await mount($, on, { hasDeploy: false, shots: [], selected: 'index', errors: [] })
  expect(await ui.find({ type: 'Text', text: /保存すると、ここに画面が出ます/ })).toBeTruthy()
  expect(await ui.find({ type: 'Svg' })).toBeFalsy()
  await ui.unmount()
})

test('直す・切り替えが呼ばれる。エラー行は file:line(推定) と1行目だけ', async ($, on) => {
  let fixed = -1
  let sel = ''
  const ui = await mount($, on, VIEW, 'desktop', { onFix: (i: number) => { fixed = i }, onSelect: (p: string) => { sel = p } })
  expect(await ui.find({ type: 'Text', text: /js\/desktop\.js:5\(推定\) ReferenceError: foo ?$/ })).toBeTruthy()
  await ui.press({ plugin: 'test', key: 'screen-fix-0' })
  await ui.press({ plugin: 'test', key: 'screen-detail' })
  await ui.unmount()
  expect(fixed).toBe(0)
  expect(sel).toBe('detail')
})

test('ターミナルに Svg は無く、文字の行と直すボタンは出る', async ($, on) => {
  const ui = await mount($, on, VIEW, 'terminal')
  expect(await ui.find({ type: 'Svg' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /画面: 一覧 540×338 \(デスクトップ版で表示\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'screen-fix-0' })).toBeTruthy()
  await ui.unmount()
})

test('デスクトップ: 画面の枠(round)があり、primary は選択中だけ', async ($, on) => {
  const ui = await mount($, on, VIEW)
  const frame = (await ui.find({ type: 'Box', key: 'screen-frame' })) as any
  expect(frame).toBeTruthy()
  expect(frame.props.borderStyle).toBe('round')
  expect(((await ui.find({ type: 'Button', key: 'screen-index' })) as any).props.variant).toBe('primary')
  expect(((await ui.find({ type: 'Button', key: 'screen-detail' })) as any).props.variant).not.toBe('primary')
  await ui.unmount()
})
