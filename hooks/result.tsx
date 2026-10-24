// 「次の一手」の結果をカードにする。生の URL・ファイルの場所は画面に出さない(URL は Link の href だけ)。
import { GAP_INNER } from './section'

export type ResultCard = { line: string; links: { label: string; href: string }[]; note?: string }

const URL_RE = /https?:\/\/[^\s)）]+/g
const PATH_RE = /\S*\/\S*\.\w+\S*|\/tmp\S*/g
const FAIL_RE = /できません|失敗|読めません|作れませんでした|片付けられません|分かりませんでした|ありません/

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const scrub = (s: string) => s.replace(URL_RE, '').replace(PATH_RE, '').replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim()

function linksOf(md: string): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = []
  for (const l of md.split('\n')) {
    for (const m of l.matchAll(URL_RE)) {
      const before = l.slice(0, m.index).replace(/[:：]\s*$/, '').trim()
      out.push({ label: before && before.length <= 12 ? `${before}を開く ↗` : '開く ↗', href: m[0] })
    }
  }
  return out
}

const DONE: Record<number, string> = {
  1: '画面を開けます',
  2: '設定画面を開けます',
  3: '見た目の一覧を撮りました',
  4: '作りたい物を会話で送ってください',
  6: '本番に入れる手順を出しました',
  7: '配布用の zip を作りました',
  8: '試験データを片付けました',
}
const FAILED: Record<number, string> = {
  1: '画面の場所が分かりません',
  2: '設定画面の場所が分かりません',
  3: '見た目を撮れませんでした',
  6: '本番の接続先がありません',
  7: 'zip を作れませんでした',
  8: '片付けられませんでした',
}

export function resultCard(n: number, md: string): ResultCard {
  const lines = (md || '').split('\n').map(s => s.trim()).filter(Boolean)
  // 「kin: 8 は今は選べません…」のような断りは、その1行をそのまま(短く)出す
  if (/^kin:\s/.test(lines[0] ?? '')) {
    const t = scrub((lines[0] ?? '').replace(/^kin:\s*/, ''))
    return { line: clip(t.split('。')[0] || t, 30), links: [] }
  }
  const links = linksOf(md || '')
  const body = lines.slice(1)
  const expectUrl = n === 1 || n === 2
  const bodyFail = n === 1 ? FAIL_RE.test(lines[0] ?? '') : body.length > 0 && FAIL_RE.test(body[0])
  const failed = n === 4 ? false : bodyFail || (expectUrl && links.length === 0)
  if (failed) {
    const first = scrub(n === 1 ? (lines[0] ?? '').replace(/^\d+\s*[^:：]*[:：]/, '') : body[0] ?? '')
    const line = first && first.length <= 30 ? first : FAILED[n] ?? clip(first || '実行できませんでした', 30)
    const note = first && first.length > 30 ? clip(first, 40) : undefined
    return { line, links, ...(note ? { note } : {}) }
  }
  let note: string | undefined
  if (n === 2) note = '保存後に「アプリを更新」を押します'
  else if (n === 3) note = 'このプラグインでは1回だけです'
  else if (n === 6) {
    const m = (body[1] ?? '').match(/\/kin use \S+/)
    note = m ? `${m[0]} から進めます` : undefined
  } else if (n === 7) {
    const m = (body[0] ?? '').match(/version\s*([\w.\-]+)/)
    note = m ? `version ${m[1]}` : undefined
  } else if (n === 8) note = scrub(body[0] ?? '') || undefined
  return { line: DONE[n] ?? clip(scrub(body[0] ?? lines[0] ?? '') || '終わりました', 30), links, ...(note ? { note: clip(note, 40) } : {}) }
}

export function renderResultCard(el: any, surface: string, card: ResultCard): unknown {
  const { Box, Text, Link } = el
  const terminal = surface === 'terminal' || !Link
  return (
    <Box key="result-card" borderStyle="round" borderDimColor paddingX={1} flexDirection="column" gap={GAP_INNER}>
      <Text>{card.line}</Text>
      {card.links.length > 0 && (
        <Box flexDirection="row" flexWrap="wrap" gap="md">
          {card.links.map((l, i) =>
            terminal ? (
              <Text key={`result-link-${i}`} size="caption" dimColor>{l.label}</Text>
            ) : (
              <Link key={`result-link-${i}`} href={l.href} label={l.label} />
            ),
          )}
        </Box>
      )}
      {card.note && <Text size="caption" dimColor>{card.note}</Text>}
    </Box>
  )
}
