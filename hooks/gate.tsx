// 本番の確認ダイアログ(小さい第2の pane)。純関数だけ。文面は gateLines、描画は renderGate。
// 秘匿: ホスト名・メールは lines に入れない(名前・番号・時刻だけ)。
import { TONE_COLOR } from './views'
import type { GateView } from './views'

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (at: number) => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type GateParams = {
  kind: 'deploy' | 'undo' | 'customize' | 'use' | 'form'
  appId: string
  name?: string
  version?: string
  appName?: string
  backupAt?: number | null
  plan?: string[]
  profileName?: string
}

export function gateLines(p: GateParams): GateView {
  const target = `対象 アプリ ${p.appId}${p.appName ? ' ' + p.appName : ''}`
  const backup = `直前の控え ${p.backupAt ? hhmm(p.backupAt) : 'なし(反映の前に取ります)'}`
  switch (p.kind) {
    case 'deploy':
      return {
        title: '本番に反映しますか',
        lines: [`プラグイン ${p.name ?? ''}${p.version ? ' 版 ' + p.version : ''}`, target, backup],
        okLabel: '反映',
      }
    case 'undo':
      return {
        title: '本番を元に戻しますか',
        lines: [target, `戻す先 ${p.backupAt ? '控え ' + hhmm(p.backupAt) : '直前の控え'}`, 'プラグインと JS/CSS を控えの版に戻します'],
        okLabel: '戻す',
      }
    case 'customize':
      return { title: '本番の JS/CSS を変えますか', lines: [target, 'JS/CSS カスタマイズを差し替えます', backup], okLabel: '反映' }
    case 'use':
      return {
        title: '接続先を本番に切り替えますか',
        lines: [`接続先 ${p.profileName ?? ''}`, '以後の反映は本番の確認が要ります'],
        okLabel: '切り替える',
      }
    case 'form': {
      const plan = p.plan ?? []
      const rest = plan.length ? plan.slice(0, 2) : ['変更 n 件'.replace('n', String(0))]
      return { title: '本番のフォームを変えますか', lines: [target, ...rest], okLabel: '実行' }
    }
  }
}

export function renderGate(el: any, surface: string, v: GateView, actions: { onOk: () => void; onCancel: () => void }): unknown {
  const { Box, Button, Text } = el
  void surface
  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row">
        <Text weight="bold">{v.title} </Text>
        <Text color={TONE_COLOR.prod}>本番</Text>
      </Box>
      {v.lines.slice(0, 3).map((l, i) => (
        <Text key={`gate-l${i}`}>{l}</Text>
      ))}
      <Box flexDirection="row">
        <Button key="gate-ok" label={v.okLabel} variant="primary" hotkey="y" onPress={actions.onOk} />
        <Text> </Text>
        <Button key="gate-cancel" label="やめる" hotkey="n" onPress={actions.onCancel} />
      </Box>
      <Text dimColor>Esc で閉じる(何も変えません)</Text>
    </Box>
  )
}
