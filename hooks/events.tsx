// イベントの流れ: 種類ごとの発火数を細い横棒で出す。純関数だけ。Svg は使わない(Box の幅% なので terminal でも同じ)。
// 文字の段は3つ: 題=heading+bold / 本文=指定なし / 小・灰=caption+dimColor
import type { EventsView } from './views'
import { GAP_INNER, foldRow, sectionHead } from './section'

const MAX_ROWS = 5

// 色は種類で固定: index(index.edit 含む)=青 / detail=緑 / create・edit=橙 / それ以外=灰
export function eventTone(type: string): string {
  if (type.includes('.index.')) return 'suggestion'
  if (type.includes('.detail.')) return 'success'
  if (type.includes('.create.') || type.includes('.edit.')) return 'warning'
  return 'inactive'
}

// 短い名前: app.record. を落とす / mobile は頭に「mobile 」 / space.portal. は portal. に
export function shortEventName(type: string): string {
  let mobile = false
  let t = type
  if (t.startsWith('mobile.')) {
    mobile = true
    t = t.slice('mobile.'.length)
  }
  if (t.startsWith('app.record.')) t = t.slice('app.record.'.length)
  else if (t.startsWith('space.portal.')) t = 'portal.' + t.slice('space.portal.'.length)
  return mobile ? `mobile ${t}` : t
}

export function renderEvents(
  el: any,
  surface: string,
  v: EventsView | null,
  opts?: { showAll?: boolean; onShowAll?: () => void },
): unknown {
  if (!v || !v.rows.length) return null
  const { Box, Text } = el
  const showAll = !!opts?.showAll
  const sorted = v.rows.map((r, i) => ({ r, i })).sort((a, b) => b.r.count - a.r.count || a.i - b.i).map(x => x.r)
  const rows = showAll ? sorted : sorted.slice(0, MAX_ROWS)
  const rest = sorted.length - rows.length
  const max = Math.max(...sorted.map(r => r.count), 0)
  return (
    <Box flexDirection="column" gap={GAP_INNER}>
      {sectionHead(el, 'ev-head', 'イベント', <Text size="caption" dimColor>{`読み込み ${v.loads}回`}</Text>)}
      {rows.map(r => {
        const color = eventTone(r.type)
        const zero = r.count <= 0
        const pct = !zero && max > 0 ? Math.max(2, Math.round((r.count / max) * 100)) : 0
        const short = shortEventName(r.type)
        const sub = `発火 ${r.count} · 登録 ${r.handlers}` + (short !== r.type ? ` · ${r.type}` : '')
        return (
          <Box key={`ev-${r.type}`} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor={zero}>{short}</Text>
              <Text color={zero ? 'inactive' : color}>●</Text>
            </Box>
            <Text size="caption" dimColor>{sub}</Text>
            {!zero && (
              <Box width="100%" height={1} backgroundColor="subtle">
                <Box width={`${pct}%`} height={1} backgroundColor={color} />
              </Box>
            )}
          </Box>
        )
      })}
      {rest > 0 && opts?.onShowAll && foldRow(el, 'ev-more', `他 ${rest} 件`, false, opts.onShowAll)}
      {rest > 0 && !opts?.onShowAll && foldRow(el, 'ev-more', `他 ${rest} 件`, false, () => {})}
      {showAll && sorted.length > MAX_ROWS && opts?.onShowAll && foldRow(el, 'ev-more', `他 ${sorted.length - MAX_ROWS} 件`, true, opts.onShowAll)}
    </Box>
  )
}
