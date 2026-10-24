// v1.1 pane の節の作法(見本の「Running · 3」)。見出しは小/灰・太字にしない。文字の段は3つだけ:
// 題=size heading + bold / 本文=指定なし / 見出し・副題・補足=size caption + dimColor
export const GAP_SECTION = 'lg' // 節と節の間(1.5 行分)
export const GAP_INNER = 'xs' // 節の中(0.5 行分)

// 節の見出し: 左に小/灰の題、右に何か(数・ボタン)
export function sectionHead(el: any, key: string, title: string, right?: unknown): unknown {
  const { Box, Text } = el
  return (
    <Box key={key} flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text size="caption" dimColor>{title}</Text>
      {right ?? null}
    </Box>
  )
}

// 折りたたみ行: 「▸ 詳細」「▾ 詳細」の1つの Button(ラベル+ボタンの2つにしない)
export function foldRow(el: any, key: string, label: string, open: boolean, onPress: () => void): unknown {
  const { Button } = el
  return <Button key={key} label={`${open ? '▾' : '▸'} ${label}`} dimColor={!open} onPress={onPress} />
}
