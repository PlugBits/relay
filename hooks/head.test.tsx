import { expect, test } from 'claude-code/testing'

import { renderBand } from './band'
import { hhmm, renderHead, renderTiles } from './head'
import type { BandView, HeadView } from './views'

const at = new Date(2026, 9, 23, 9, 5).getTime()
const H: HeadView = { appId: '12', appName: '製造管理', kind: 'dev', last: { at, seconds: 7.5, ok: true }, errors: 0 }
const B: BandView = { conn: { name: 'dev', kind: 'dev' }, app: { id: '12', name: '製造管理' }, last: { at, seconds: 7.5, ok: true }, errors: 0, pending: null }

let draw: (el: any, surface: string) => unknown = () => null
const setup = (on: any) => on('ui.render', ($: any, e: any) => draw($.ui.resolve(e), e.surface))
const mount = async ($: any, on: any, surface: string, fn: (el: any, s: string) => unknown) => {
  draw = fn
  const ui = await $.ui.mount({ plugin: 'x', component: 'Pane', requestId: 'p', surface, props: { title: 't', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as any)
  return { ui, all: JSON.stringify(await ui.findAll({})) }
}

test('hhmm は0埋め', () => {
  expect(hhmm(at)).toBe('09:05')
})

test('タイル3つ: 反映 / エラー / 最終', async ($, on) => {
  setup(on)
  const m = await mount($, on, 'desktop', (el, s) => renderTiles(el, s, H))
  for (const k of ['tile-deploy', 'tile-errors', 'tile-last']) expect(await m.ui.find({ key: k })).toBeTruthy()
  for (const c of ['反映', 'エラー', '最終']) expect(m.all).toContain(c)
  expect(m.all).toContain('8秒')
  expect(m.all).toContain('09:05')
  expect(m.all).not.toContain('Svg')
  await m.ui.unmount()
})

test('エラー 0 は success、2 は error の色', async ($, on) => {
  setup(on)
  let m = await mount($, on, 'desktop', (el, s) => renderTiles(el, s, H))
  expect(m.all).toContain('success')
  expect(m.all).not.toContain('"error"')
  await m.ui.unmount()
  m = await mount($, on, 'desktop', (el, s) => renderTiles(el, s, { ...H, errors: 2 }))
  expect(m.all).toContain('"error"')
  expect(m.all).not.toContain('success')
  await m.ui.unmount()
})

test('反映なしは — で色なし', async ($, on) => {
  setup(on)
  const m = await mount($, on, 'desktop', (el, s) => renderTiles(el, s, { ...H, last: null }))
  expect(m.all).toContain('—')
  expect(m.all).not.toContain('success')
  expect(m.all).not.toContain('"error"')
  await m.ui.unmount()
})

test('頭: 開発/本番の丸角ラベルと色、× なし、未設定は「はじめに」', async ($, on) => {
  setup(on)
  let m = await mount($, on, 'desktop', (el, s) => renderHead(el, s, H))
  expect(m.all).not.toContain('プラグイン作成 mod')
  expect(m.all).toContain('製造管理')
  expect(m.all).toContain('開発')
  expect(m.all).toContain('suggestion')
  expect(m.all).not.toContain('head-close')
  await m.ui.unmount()
  m = await mount($, on, 'desktop', (el, s) => renderHead(el, s, { ...H, kind: 'prod', appName: undefined }))
  expect(m.all).toContain('本番')
  expect(m.all).toContain('warning')
  expect(m.all).toContain('アプリ 12')
  expect(m.all).not.toContain('head-close')
  expect(m.all).not.toContain('Svg')
  await m.ui.unmount()
  m = await mount($, on, 'desktop', (el, s) => renderHead(el, s, { ...H, appId: null, appName: undefined, kind: null }))
  expect(m.all).toContain('はじめに')
  expect(m.all).not.toContain('反映先が未設定')
  await m.ui.unmount()
})

test('頭: onConn があれば head-conn ボタン(開発 ▾ / 接続先 ▾ / ▴)、押すと onConn', async ($, on) => {
  setup(on)
  let n = 0
  const onConn = () => { n++ }
  let m = await mount($, on, 'desktop', (el, s) => renderHead(el, s, H, onConn))
  expect((await m.ui.find({ type: 'Button', key: 'head-conn' })).text).toContain('開発 ▾')
  expect(m.all).not.toContain('head-pill')
  await m.ui.press({ plugin: 'test', key: 'head-conn' })
  expect(n).toBe(1)
  await m.ui.unmount()
  m = await mount($, on, 'desktop', (el, s) => renderHead(el, s, { ...H, kind: null }, onConn, true))
  expect((await m.ui.find({ type: 'Button', key: 'head-conn' })).text).toContain('接続先 ▴')
  await m.ui.unmount()
})

test('帯(desktop): エラー 0 は出さず、1 なら赤', async ($, on) => {
  setup(on)
  const act = { onOk() {}, onCancel() {} }
  let m = await mount($, on, 'desktop', (el, s) => renderBand(el, s, B, act))
  expect(m.all).toContain('アプリ 12')
  expect(m.all).toContain('最後の反映')
  expect(m.all).not.toContain('エラー')
  expect(m.all).not.toContain('Svg')
  await m.ui.unmount()
  m = await mount($, on, 'desktop', (el, s) => renderBand(el, s, { ...B, errors: 1 }, act))
  expect(m.all).toContain('エラー 1')
  expect(m.all).toContain('"error"')
  await m.ui.unmount()
})

test('帯: 戻す は v.undo がある時だけ、反映待ちは ok/cancel', async ($, on) => {
  setup(on)
  let undone = 0
  const act = { onOk() {}, onCancel() {}, onUndo: () => { undone++ } }
  for (const surface of ['desktop', 'terminal']) {
    let m = await mount($, on, surface, (el, s) => renderBand(el, s, B, act))
    expect(m.all).not.toContain('band-undo')
    await m.ui.unmount()
    m = await mount($, on, surface, (el, s) => renderBand(el, s, { ...B, undo: { appId: '12' } }, act))
    expect(m.all).toContain('band-undo')
    expect(await m.ui.find({ type: 'Button', key: 'band-undo' })).toBeTruthy()
    await m.ui.unmount()
    m = await mount($, on, surface, (el, s) => renderBand(el, s, { ...B, undo: { appId: '12' }, pending: { headline: 'アプリ 12 に反映', okLabel: '反映' } }, act))
    expect(m.all).toContain('band-ok')
    expect(m.all).toContain('band-cancel')
    expect(m.all).not.toContain('band-undo')
    await m.ui.unmount()
  }
  expect(undone).toBe(0)
})

test('戻す を押すと onUndo(スタブ要素で呼ぶ)', () => {
  const found: any[] = []
  const stub = (t: string) => (p: any) => ({ t, p })
  const el = { Box: stub('Box'), Text: stub('Text'), Button: (p: any) => (found.push(p), null) }
  let n = 0
  const tree: any = renderBand(el, 'desktop', { ...B, undo: { appId: '12' } }, { onOk() {}, onCancel() {}, onUndo: () => { n++ } })
  expect(tree).toBeTruthy()
  expect(found.map(f => f.key)).toEqual(['band-undo'])
  found[0].onPress()
  expect(n).toBe(1)
})

test('帯: 接続なしは案内だけ', async ($, on) => {
  setup(on)
  const m = await mount($, on, 'desktop', (el, s) => renderBand(el, s, { ...B, conn: null }, { onOk() {}, onCancel() {} }))
  expect(m.all).toContain('/kin setup で接続設定')
  await m.ui.unmount()
})
