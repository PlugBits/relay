import { hhmm } from './head'
import { TONE_COLOR } from './views'
import type { BandView } from './views'

export const START_HINT = 'はじめに: 作る / 直す / 接続先 を右のパネルから'
export const BAND_GUIDE = '番号を送るかボタンを押す(言葉で頼んでも可)'

const appLabel = (v: BandView) => (v.app ? `アプリ ${v.app.id}${v.app.name ? ` ${v.app.name}` : ''}` : 'アプリ 未設定(/kin <番号>)')
const lastLabel = (v: BandView) =>
  v.last ? `最後の反映 ${hhmm(v.last.at)} · ${Math.round(v.last.seconds)}秒${v.last.ok ? '' : '(失敗)'}` : '最後の反映 —'

// ターミナルの1行(エラー 0 は出さない)
export function bandText(v: BandView): string {
  if (v.pending) return `本番に反映待ち: ${v.pending.headline}`
  if (!v.conn) return '/kin setup で接続設定'
  if (!v.app) return `● ${v.conn.name}(${v.conn.kind === 'prod' ? '本番' : '開発'}) · ${START_HINT}`
  const parts = [`● ${v.conn.name}(${v.conn.kind === 'prod' ? '本番' : '開発'})`, appLabel(v), lastLabel(v)]
  if (v.errors >= 1) parts.push(`エラー ${v.errors}`)
  return parts.join(' · ')
}

export function renderBand(
  el: any,
  surface: string,
  v: BandView,
  actions: { onOk: () => void; onCancel: () => void; onUndo?: () => void },
): unknown {
  const { Box, Button, Text } = el
  const desktop = surface === 'desktop'

  if (v.pending) {
    return (
      <Box flexDirection="row">
        <Text color={TONE_COLOR.err} weight="bold">本番に反映待ち:</Text>
        <Text> {v.pending.headline} </Text>
        <Button key="band-ok" label={v.pending.okLabel} variant="primary" onPress={actions.onOk} />
        <Text> </Text>
        <Button key="band-cancel" label="やめる" onPress={actions.onCancel} />
      </Box>
    )
  }

  const undo = v.undo && actions.onUndo ? <Button key="band-undo" label="戻す" onPress={actions.onUndo} /> : null
  if (!desktop) {
    // 1行のまま(プロンプトの上)
    return (
      <Box flexDirection="row">
        <Text dimColor={!v.conn} color={v.conn ? TONE_COLOR[v.conn.kind] : undefined}>{bandText(v)}</Text>
        {undo && <Text> </Text>}
        {undo}
      </Box>
    )
  }
  if (!v.conn) {
    return (
      <Box flexDirection="row">
        <Text dimColor>/kin setup で接続設定</Text>
      </Box>
    )
  }
  const tone = TONE_COLOR[v.conn.kind]
  return (
    <Box flexDirection="row" gap={1} alignItems="center">
      <Text color={tone}>●</Text>
      <Text weight="bold">{v.conn.name}</Text>
      {v.app ? (
        <Box key="band-app" borderStyle="round" borderDimColor paddingX={1}>
          <Text>{appLabel(v)}</Text>
        </Box>
      ) : null}
      <Text size={v.app ? undefined : 'caption'} dimColor>{v.app ? lastLabel(v) : START_HINT}</Text>
      {v.errors >= 1 && <Text color={TONE_COLOR.err}>{`エラー ${v.errors}`}</Text>}
      {undo}
    </Box>
  )
}
