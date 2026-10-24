// pane の頭とタイル(参照: Claude Desktop の Agents パネル)。純関数だけ。色は状態の4色(TONE_COLOR)にだけ使う。
import { TONE_COLOR } from './views'
import type { HeadView, Tone } from './views'

const pad = (n: number) => String(n).padStart(2, '0')
export const hhmm = (at: number) => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 頭: アプリ名(題の段) + 開発/本番の丸角ラベル。未設定なら「はじめに」
export function renderHead(el: any, surface: string, v: HeadView, onConn?: () => void, connOpen?: boolean): unknown {
  const { Box, Text, Button } = el
  const tone: Tone | null = v.kind
  const name = v.appId === null ? 'はじめに' : (v.appName ?? `アプリ ${v.appId}`)
  return (
    <Box key="head" flexDirection="row" gap={1} alignItems="center">
      <Text weight="bold" size="heading">{name}</Text>
      {onConn ? (
        <Button key="head-conn" label={`${tone ? (tone === 'prod' ? '本番' : '開発') : '接続先'} ${connOpen ? '▴' : '▾'}`} onPress={onConn} />
      ) : tone && (
        <Box key="head-pill" borderStyle="round" borderColor={TONE_COLOR[tone]} paddingX={1}>
          <Text color={TONE_COLOR[tone]}>{tone === 'prod' ? '本番' : '開発'}</Text>
        </Box>
      )}
    </Box>
  )
}

// タイル: 反映(秒) / エラー(数) / 最終(時刻)
export function renderTiles(el: any, surface: string, v: HeadView): unknown {
  const { Box, Text } = el
  const tile = (key: string, caption: string, value: string, color?: string) => (
    <Box key={key} flexGrow={1} flexDirection="column" borderStyle="round" borderDimColor padding={1}>
      <Text size="caption" dimColor>{caption}</Text>
      <Text weight="bold" size="heading" color={color}>{value}</Text>
    </Box>
  )
  const errColor = v.last ? TONE_COLOR[v.errors >= 1 ? 'err' : 'ok'] : undefined
  return (
    <Box key="tiles" flexDirection="row" gap={1}>
      {tile('tile-deploy', '反映', v.last ? `${Math.round(v.last.seconds)}秒` : '—')}
      {tile('tile-errors', 'エラー', v.last ? String(v.errors) : '—', errColor)}
      {tile('tile-last', '最終', v.last ? hhmm(v.last.at) : '—')}
    </Box>
  )
}
