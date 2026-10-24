// フォームの地図: REST の fields.json / layout.json の値だけから組む(kintone の画面 DOM には触らない)。
// 状態は持たない純関数。デスクトップは Box/Text/Button の面部品だけ(Svg は使わない)。
import { GAP_INNER, foldRow } from './section'
import type { FormField, FormMapData, LayoutField, LayoutRow } from './views'

const DEF_W = 200

type Cat = { name: string }
const CATS: Record<string, Cat> = {
  text: { name: '文字列' },
  num: { name: '数値' },
  date: { name: '日付' },
  choice: { name: '選択' },
  lookup: { name: 'ルックアップ' },
  sub: { name: 'サブテーブル' },
  calc: { name: '計算' },
  file: { name: '添付' },
  user: { name: 'ユーザー' },
  other: { name: 'その他' },
}
const CAT_OF: Record<string, string> = {
  SINGLE_LINE_TEXT: 'text', MULTI_LINE_TEXT: 'text', RICH_TEXT: 'text', LINK: 'text', RECORD_NUMBER: 'text',
  NUMBER: 'num',
  DATE: 'date', DATETIME: 'date', TIME: 'date', CREATED_TIME: 'date', UPDATED_TIME: 'date',
  RADIO_BUTTON: 'choice', CHECK_BOX: 'choice', DROP_DOWN: 'choice', MULTI_SELECT: 'choice',
  SUBTABLE: 'sub', CALC: 'calc', FILE: 'file',
  USER_SELECT: 'user', ORGANIZATION_SELECT: 'user', GROUP_SELECT: 'user', CREATOR: 'user', MODIFIER: 'user', STATUS_ASSIGNEE: 'user',
}
const catOf = (f?: FormField, t?: string): Cat => (f?.lookup ? CATS.lookup : CATS[CAT_OF[f?.type ?? t ?? ''] ?? 'other'])
const plain = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()

// ---- モデル ----
type Cell =
  | { k: 'field'; code: string; label: string; type: string; w: number; f?: FormField }
  | { k: 'label'; text: string; w: number }
  | { k: 'space'; w: number }
type Node =
  | { k: 'row'; cells: Cell[] }
  | { k: 'sub'; code: string; label: string; cells: Cell[] }
  | { k: 'group'; code: string; label: string; nodes: Node[] }

const widthOf = (lf: LayoutField, dflt = DEF_W): number => {
  const n = Number(lf.size?.width)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : dflt
}

function index(fields: FormField[], into = new Map<string, FormField>()): Map<string, FormField> {
  for (const f of fields) {
    if (!into.has(f.code)) into.set(f.code, f)
    if (f.subtable) index(f.subtable, into)
  }
  return into
}

function toCell(lf: LayoutField, by: Map<string, FormField>): Cell | null {
  if (lf.type === 'LABEL') return { k: 'label', text: plain(String(lf.label ?? '')), w: widthOf(lf) }
  if (lf.type === 'SPACER' || lf.type === 'HR') return { k: 'space', w: widthOf(lf) }
  if (!lf.code) return null
  const f = by.get(lf.code)
  return { k: 'field', code: lf.code, label: f?.label ?? lf.label ?? lf.code, type: f?.type ?? lf.type, w: widthOf(lf), f }
}

function fromLayout(layout: LayoutRow[], by: Map<string, FormField>): Node[] {
  const out: Node[] = []
  for (const r of layout) {
    if (r.type === 'ROW') {
      const cells = (r.fields ?? []).map(lf => toCell(lf, by)).filter((c): c is Cell => c !== null)
      if (cells.length) out.push({ k: 'row', cells })
    } else if (r.type === 'SUBTABLE') {
      const f = by.get(r.code)
      const cells = (r.fields ?? []).map(lf => toCell(lf, by)).filter((c): c is Cell => c !== null)
      out.push({ k: 'sub', code: r.code, label: f?.label ?? r.code, cells })
    } else if (r.type === 'GROUP') {
      const f = by.get(r.code)
      out.push({ k: 'group', code: r.code, label: f?.label ?? r.code, nodes: fromLayout(r.layout ?? [], by) })
    }
  }
  return out
}

function fromFields(fields: FormField[]): Node[] {
  return fields.map((f): Node => {
    if (f.type === 'SUBTABLE' || f.subtable) {
      const cells = (f.subtable ?? []).map((c): Cell => ({ k: 'field', code: c.code, label: c.label ?? c.code, type: c.type, w: 160, f: c }))
      return { k: 'sub', code: f.code, label: f.label ?? f.code, cells }
    }
    return { k: 'row', cells: [{ k: 'field', code: f.code, label: f.label ?? f.code, type: f.type, w: 320, f }] }
  })
}

function model(d: FormMapData): Node[] {
  const by = index(d.fields)
  return d.layout && d.layout.length ? fromLayout(d.layout, by) : fromFields(d.fields)
}

const countFields = (nodes: Node[]): number =>
  nodes.reduce(
    (n, x) =>
      n + (x.k === 'group' ? countFields(x.nodes) : x.cells.filter(c => c.k === 'field').length),
    0,
  )

// ---- 文字だけの地図(ターミナル) ----
export function formMapLines(d: FormMapData, maxFields = 80): { lines: string[]; shown: number; cut: number } {
  const nodes = model(d)
  const total = countFields(nodes)
  let left = maxFields
  const lines: string[] = []
  const cellsText = (cells: Cell[]): string =>
    cells
      .map(c => {
        if (c.k === 'space') return ''
        if (c.k === 'label') return c.text ? `「${c.text}」` : ''
        if (left <= 0) return ''
        left--
        return `[${c.label} ${c.code} ${catOf(c.f, c.type).name}${c.f?.required ? '*' : ''}]`
      })
      .filter(Boolean)
      .join(' ')
  const walk = (ns: Node[], ind: string) => {
    for (const n of ns) {
      if (n.k === 'row') {
        const t = cellsText(n.cells)
        if (t) lines.push(ind + t)
      } else if (n.k === 'sub') {
        lines.push(`${ind}▦ ${n.label} (${n.code})`)
        const t = cellsText(n.cells)
        if (t) lines.push(`${ind}  ${t}`)
      } else {
        lines.push(`${ind}▾ ${n.label}`)
        walk(n.nodes, ind + '  ')
      }
    }
  }
  walk(nodes, '')
  return { lines, shown: Math.min(maxFields, total), cut: Math.max(0, total - maxFields) }
}

// ---- pane ----
export type FormMapActions = { onPick: (code: string) => void; open: boolean; onToggle: () => void; showAll: boolean; onShowAll: () => void }
const CAP = 80

export function renderFormMap(el: any, surface: string, d: FormMapData, actions: FormMapActions): unknown {
  const { Box, Text, Button } = el
  const head = `フォーム アプリ ${d.appId}${d.appName ? ' ' + d.appName : ''}`
  if (surface === 'terminal') {
    const t = formMapLines(d)
    return (
      <Box flexDirection="column">
        <Text weight="bold">{head}</Text>
        {t.lines.map((l, i) => (
          <Text key={`fm-l-${i}`}>{l}</Text>
        ))}
        {t.cut > 0 && <Text dimColor>{`他 ${t.cut} 欄`}</Text>}
        <Text dimColor>欄を押すとフィールドコードが入力欄に入ります(デスクトップ版)</Text>
      </Box>
    )
  }
  // layout が無いときは素の欄を1つの折り返す行にまとめる
  const nodes = model(d).reduce<Node[]>((acc, n) => {
    const p = acc[acc.length - 1]
    if (!(d.layout && d.layout.length) && n.k === 'row' && p?.k === 'row') p.cells.push(...n.cells)
    else acc.push(n)
    return acc
  }, [])
  const total = countFields(nodes)
  const cap = actions.showAll ? total : Math.min(CAP, total)
  let left = cap
  let seq = 0
  const chip = (c: Extract<Cell, { k: 'field' }>) => {
    left--
    const req = c.f?.required ? '*' : ''
    return (
      <Button key={`fm-${c.code}`} onPress={() => actions.onPick(c.code)}>
        {c.label} <Text size="caption" dimColor>{catOf(c.f, c.type).name + req}</Text>
      </Button>
    )
  }
  // 入りきらない分(left が尽きた欄)は出さない
  const cells = (cs: Cell[]) =>
    cs.flatMap(c => {
      if (c.k === 'space') return []
      if (c.k === 'label') return c.text ? [<Text key={`fm-t-${seq++}`} size="caption" dimColor>{c.text}</Text>] : []
      return left > 0 ? [chip(c)] : []
    })
  const walk = (ns: Node[]): unknown[] =>
    ns.flatMap(n => {
      if (left <= 0) return []
      const k = `fm-b-${seq++}`
      if (n.k === 'row') {
        const cs = cells(n.cells)
        return cs.length ? [<Box key={k} flexWrap="wrap" gap={1}>{cs}</Box>] : []
      }
      if (n.k === 'sub') {
        return [
          <Box key={k} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text size="caption" dimColor>{`▦ ${n.label}`}</Text>
            <Box flexWrap="wrap" gap={1}>{cells(n.cells)}</Box>
          </Box>,
        ]
      }
      return [
        <Box key={k} flexDirection="column">
          <Text size="caption" dimColor>{`▾ ${n.label}`}</Text>
          <Box flexDirection="column" paddingLeft={2}>{walk(n.nodes)}</Box>
        </Box>,
      ]
    })
  const body = actions.open ? walk(nodes) : []
  const cut = total - cap
  return (
    <Box flexDirection="column" gap={GAP_INNER}>
      {foldRow(el, 'form-toggle', `フォーム ${total}`, actions.open, actions.onToggle)}
      {body}
      {actions.open && cut > 0 && (
        <Box gap={1}>
          <Text size="caption" dimColor>{`他 ${cut} 欄`}</Text>
          <Button key="form-all" label="見る" onPress={actions.onShowAll} />
        </Box>
      )}
    </Box>
  )
}
