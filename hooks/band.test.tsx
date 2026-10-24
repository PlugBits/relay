import { expect, test } from 'claude-code/testing'

import { BAND_GUIDE, bandText } from './band'
import type { BandView } from './views'

const base: BandView = { conn: null, app: null, last: null, errors: 0, pending: null }
const at = new Date(2026, 9, 23, 9, 5).getTime()

test('接続なし', () => {
  expect(bandText(base)).toBe('/kin setup で接続設定')
})

test('開発・アプリ・最後の反映・エラー', () => {
  const v: BandView = { ...base, conn: { name: 'dev', kind: 'dev' }, app: { id: '12', name: '製造管理' }, last: { at, seconds: 7.5, ok: true }, errors: 2 }
  expect(bandText(v)).toBe('● dev(開発) · アプリ 12 製造管理 · 最後の反映 09:05 · 8秒 · エラー 2')
})

test('本番・アプリ名なし', () => {
  const v: BandView = { ...base, conn: { name: 'main', kind: 'prod' }, app: { id: '13' }, last: { at, seconds: 3, ok: true } }
  expect(bandText(v)).toBe('● main(本番) · アプリ 13 · 最後の反映 09:05 · 3秒')
})

test('アプリ未設定: はじめにの案内', () => {
  const v: BandView = { ...base, conn: { name: 'dev', kind: 'dev' } }
  expect(bandText(v)).toBe('● dev(開発) · はじめに: 作る / 直す / 接続先 を右のパネルから')
  expect(bandText({ ...v, conn: { name: 'main', kind: 'prod' } })).toBe('● main(本番) · はじめに: 作る / 直す / 接続先 を右のパネルから')
})

test('失敗した反映', () => {
  const v: BandView = { ...base, conn: { name: 'dev', kind: 'dev' }, app: { id: '1' }, last: { at, seconds: 2, ok: false } }
  expect(bandText(v)).toContain('最後の反映 09:05 · 2秒(失敗)')
})

test('反映待ち', () => {
  const v: BandView = { ...base, conn: { name: 'main', kind: 'prod' }, pending: { headline: 'アプリ 13 に反映', okLabel: '反映' } }
  expect(bandText(v)).toBe('本番に反映待ち: アプリ 13 に反映')
})

test('案内文', () => {
  expect(BAND_GUIDE).toBe('番号を送るかボタンを押す(言葉で頼んでも可)')
})
