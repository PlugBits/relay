// 画面: 反映直後の縮小スクショ(JPEG)を Svg に埋めて pane に出す。純関数だけ(状態は持たない)。
// 秘匿: url は Link の href にだけ使う。文言・ログには出さない。
import { GAP_INNER, sectionHead } from './section'
import { TONE_COLOR } from './views'
import type { PulseError, ScreenPage, ScreenShot, ScreenView } from './views'

const SVG_LIMIT = 131072
const PAGE_LABEL: Record<ScreenPage, string> = { index: '一覧', detail: '詳細', config: '設定' }
const PAGES: ScreenPage[] = ['index', 'detail', 'config']
const MAX_MSG = 80

// 1:1 の Svg ソース。上限(131072 字)を超えるなら null
export function screenSvg(shot: ScreenShot, width?: number): string | null {
  if (!shot || !shot.base64) return null
  const w = Math.round(width ?? shot.width)
  const h = Math.round(width ? (shot.height * width) / shot.width : shot.height)
  const src = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image href="data:image/jpeg;base64,${shot.base64}" width="${w}" height="${h}"/></svg>`
  return src.length > SVG_LIMIT ? null : src
}

const firstLine = (s: string) => {
  const l = (s || '').split('\n')[0]
  return l.length > MAX_MSG ? `${l.slice(0, MAX_MSG - 1)}…` : l
}
const where = (e: PulseError) => (e.file ? `${e.file}${e.line ? `:${e.line}` : ''}${e.guessed ? '(推定)' : ''}` : e.page ? (PAGE_LABEL[e.page as ScreenPage] ?? e.page) : '')

export function renderScreen(
  el: any,
  surface: string,
  v: ScreenView,
  // empty: 反映前に「保存すると…」の代わりに置く物(v1.1.1 のカード2枚)。無ければ案内の文字
  actions: { onSelect: (p: ScreenPage) => void; onFix: (i: number) => void; empty?: unknown },
): unknown {
  const { Box, Text, Button, Svg, Link } = el
  const shotOf = (p: ScreenPage) => v.shots.find(s => s.page === p)
  const shot = shotOf(v.selected)
  const terminal = surface === 'terminal' || !Svg
  const svg = shot && !terminal ? screenSvg(shot) : null
  const pageButtons = PAGES.map(p =>
    shotOf(p) ? (
      <Button key={`screen-${p}`} label={PAGE_LABEL[p]} variant={p === v.selected ? 'primary' : undefined} onPress={() => actions.onSelect(p)} />
    ) : (
      <Text key={`screen-${p}`} size="caption" dimColor>{` ${PAGE_LABEL[p]} `}</Text>
    ),
  )
  const errRows = v.errors.map((er, i) => (
    <Box key={`screen-er-${i}`} flexDirection="row" flexWrap="wrap">
      <Text color={TONE_COLOR.err}>●</Text>
      <Text>{` ${where(er)} ${firstLine(er.message)} `}</Text>
      <Button key={`screen-fix-${i}`} label="直す" onPress={() => actions.onFix(i)} />
    </Box>
  ))
  if (!terminal) {
    return (
      <Box flexDirection="column" gap={GAP_INNER}>
        {sectionHead(el, 'screen-head', '画面', <Box flexDirection="row">{pageButtons}</Box>)}
        {!v.hasDeploy ? (
          actions.empty ?? <Text size="caption" dimColor>保存すると、ここに画面が出ます</Text>
        ) : (
          <Box flexDirection="column" gap={GAP_INNER}>
            {svg && shot && (
              <Box key="screen-frame" borderStyle="round" borderDimColor padding={0}>
                <Svg source={svg} alt={`${PAGE_LABEL[shot.page]} の画面(反映直後)`} width={shot.width} height={shot.height} />
              </Box>
            )}
            {shot && shot.url && Link && <Link href={shot.url} label="kintone で開く" />}
          </Box>
        )}
        {errRows}
        {v.note && <Text size="caption" dimColor>{v.note}</Text>}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap">
        <Text weight="bold">画面</Text>
        <Text>{' '}</Text>
        {PAGES.map(p =>
          shotOf(p) ? (
            <Button key={`screen-${p}`} label={PAGE_LABEL[p]} variant={p === v.selected ? 'primary' : undefined} onPress={() => actions.onSelect(p)} />
          ) : (
            <Text key={`screen-${p}`} dimColor>{` ${PAGE_LABEL[p]} `}</Text>
          ),
        )}
      </Box>
      {!v.hasDeploy ? (
        <Text dimColor>保存すると、ここに画面が出ます</Text>
      ) : (
        <Box flexDirection="column">
          {shot && terminal && <Text dimColor>{`画面: ${PAGE_LABEL[shot.page]} ${shot.width}×${shot.height} (デスクトップ版で表示)`}</Text>}
          {svg && shot && <Svg source={svg} alt={`${PAGE_LABEL[shot.page]} の画面(反映直後)`} width={shot.width} height={shot.height} />}
          {shot && shot.url && Link && <Link href={shot.url} label="kintone で開く" />}
        </Box>
      )}
      {v.errors.map((er, i) => (
        <Box key={`screen-er-${i}`} flexDirection="row" flexWrap="wrap">
          <Text color={TONE_COLOR.err}>●</Text>
          <Text>{` ${where(er)} ${firstLine(er.message)} `}</Text>
          <Button key={`screen-fix-${i}`} label="直す" onPress={() => actions.onFix(i)} />
        </Box>
      ))}
      {v.note && <Text dimColor>{v.note}</Text>}
    </Box>
  )
}
