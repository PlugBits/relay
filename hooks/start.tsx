import { GAP_INNER, sectionHead } from './section'

export type StartApp = { id: string; name: string }
export type StartStep =
  | { step: 'menu' }
  | { step: 'create'; apps: StartApp[] | null }
  | { step: 'fix'; apps: StartApp[] | null }
  | { step: 'fix-plugin'; appId: string; appName?: string; plugins: string[] | null }
export type StartActions = {
  onCreate: () => void
  onFix: () => void
  onConn: () => void
  onBack: () => void
  onPickCreateApp: (id: string) => void
  onPickFixApp: (id: string) => void
  onPickPlugin: (name: string) => void
}

export const createPrompt = (appId: string): string => `アプリ ${appId} に、<やりたいこと> を作って`
export const fixPrompt = (appId: string, plugin: string): string => `アプリ ${appId} の ${plugin} を <直したいこと> に直して`

const START_TEXT = `プラグイン作成 mod: 対象のアプリがまだ決まっていない。最初の返答で、次の3つを1行ずつ見せ、アプリの番号を聞く(番号は /kin connect か pane で見られる)。
1 新しくプラグインを作る
2 既存のプラグインを直す
3 接続先を変える
短く。ユーザーが答えるまで道具は使わない。`
export const START_COMPOSE: { id: string; text: string } = { id: 'plugbits-relay-start', text: START_TEXT }

const MAX_BUTTONS = 30
const SELECT_OVER = 8

export function renderStart(el: any, surface: string, v: StartStep, a: StartActions): unknown {
  const { Box, Button, Text } = el
  void surface

  const back = <Button key="start-back" label="← 戻る" onPress={a.onBack} />
  const loading = <Text key="start-loading" size="caption" dimColor>アプリ一覧を読んでいます…</Text>

  if (v.step === 'menu') {
    const card = (key: string, label: string, desc: string, onPress: () => void) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Button key={`${key}-go`} label={label} onPress={onPress} />
        <Text size="caption" dimColor>{desc}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column" gap={GAP_INNER}>
        {sectionHead(el, 'start-head', 'はじめに')}
        {card('start-create', '新しくプラグインを作る', 'アプリを選んで、作りたい物を言葉で', a.onCreate)}
        {card('start-fix', '既存のプラグインを直す', '付いているプラグインを選んで直す', a.onFix)}
        {card('start-conn', '接続先を変える', '開発と本番、別の kintone に切り替える', a.onConn)}
      </Box>
    )
  }

  if (v.step === 'create' || v.step === 'fix') {
    const pick = v.step === 'create' ? a.onPickCreateApp : a.onPickFixApp
    const apps = v.apps
    let body: unknown
    if (apps === null) body = loading
    else if (apps.length === 0) body = <Text key="start-empty" size="caption" dimColor>アプリがありません(/kin setup で接続先を確認)</Text>
    else if (el.Select && apps.length > SELECT_OVER) {
      const { Select } = el
      body = (
        <Select
          key="start-app"
          options={apps.map(x => ({ value: x.id, label: `${x.id} ${x.name}` }))}
          onSelect={(id: string) => pick(id)}
        />
      )
    } else {
      body = (
        <Box key="start-apps" flexDirection="column">
          {apps.slice(0, MAX_BUTTONS).map(x => (
            <Button key={`start-app-${x.id}`} label={`${x.id} ${x.name}`} onPress={() => pick(x.id)} />
          ))}
          {apps.length > MAX_BUTTONS && <Text key="start-more" size="caption" dimColor>{`他 ${apps.length - MAX_BUTTONS} 件は /kin connect`}</Text>}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={GAP_INNER}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="heading" weight="bold">アプリを選ぶ</Text>
          {back}
        </Box>
        {body}
      </Box>
    )
  }

  const plugins = v.plugins
  let body: unknown
  if (plugins === null) body = <Text key="start-loading" size="caption" dimColor>プラグイン一覧を読んでいます…</Text>
  else if (plugins.length === 0) {
    body = (
      <Box key="start-none" flexDirection="column" gap={GAP_INNER}>
        <Text size="caption" dimColor>このアプリにプラグインはありません</Text>
        <Button key="start-fix-create" label="新しく作る" onPress={() => a.onPickCreateApp(v.appId)} />
      </Box>
    )
  } else {
    body = (
      <Box key="start-plugins" flexDirection="column">
        {plugins.map((p, i) => <Button key={`start-plugin-${i}`} label={p} onPress={() => a.onPickPlugin(p)} />)}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={GAP_INNER}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text size="heading" weight="bold">{`直すプラグイン · アプリ ${v.appId}${v.appName ? ` ${v.appName}` : ''}`}</Text>
        {back}
      </Box>
      {body}
    </Box>
  )
}

// v1.1.1 反映先を選んだ後: 同じアプリで「作る」「直す」。反映前はカード2枚(画面の節の中)、反映後は次の一手の行の先頭の小さなボタン2つ
export type AppActions = { onCreate: () => void; onFix: () => void }
export function renderAppCards(el: any, surface: string, plugins: number, a: AppActions): unknown {
  const { Box, Button, Text } = el
  void surface
  const card = (key: string, label: string, desc: string, onPress: () => void) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Button key={`${key}-go`} label={label} onPress={onPress} />
      <Text size="caption" dimColor>{desc}</Text>
    </Box>
  )
  return (
    <Box key="app-cards" flexDirection="column" gap={GAP_INNER}>
      {card('app-create', 'このアプリに新しく作る', '作りたい物を言葉で。保存すると、ここに画面が出ます', a.onCreate)}
      {card('app-fix', `付いているプラグインを直す(${plugins})`, 'プラグインを選んで、直したいことを言葉で', a.onFix)}
    </Box>
  )
}
export function renderAppButtons(el: any, plugins: number, a: AppActions): unknown[] {
  const { Button } = el
  return [
    <Button key="next-create" label="新しく作る" onPress={a.onCreate} />,
    <Button key="next-fix" label={`直す(${plugins})`} onPress={a.onFix} />,
  ]
}
