// v0.9 の見せる部品(帯・鼓動・地図)が受け取る形。register.tsx が $.state から組み立てて渡す。
// 部品の側は $.state を読まない・書かない(純粋に描くだけ)。値に認証情報・ホスト名・パスは入れない。

// ---- 足元の帯(AbovePrompt) ----
export type BandView = {
  // 接続先の名前(kin-profile の name)。未設定なら null
  conn: { name: string; kind: 'dev' | 'prod' } | null
  // 反映先アプリ。未設定なら null。name は分かる時だけ
  app: { id: string; name?: string } | null
  // 最後の反映: 終わった時刻(epoch ms)と合計秒数
  last: { at: number; seconds: number; ok: boolean } | null
  // 直近の反映で拾ったエラーの数
  errors: number
  // 本番の確認待ち(帯がボタン2つになる)。headline は pendingHeadline の文字
  pending: { headline: string; okLabel: string } | null
  // v1.0 反映の直後 60 秒だけ [戻す] を出す。無ければ null か省略
  undo?: { appId: string } | null
}

// ---- 反映の鼓動 ----
export type StageKey = 'save' | 'pack' | 'upload' | 'apply' | 'check'
export type StageStatus = 'wait' | 'run' | 'ok' | 'err' | 'skip'
export type PulseStage = { key: StageKey; label: string; status: StageStatus; seconds?: number; note?: string }
export type PulseError = {
  kind: 'console' | 'pageerror'
  message: string // 伏せ済み(redact 後)
  page?: string // detail / index / config …
  // プラグインのファイルと行が分かった時だけ。file はプラグインのフォルダからの相対(例 js/desktop.js)
  file?: string
  line?: number
  // 該当行の前後3行(startLine から)。読めた時だけ
  snippet?: { startLine: number; source: string; language?: string }
  // ファイルが URL から特定できず、manifest の JS が1本なので推定した
  guessed?: boolean
}
export type Pulse = {
  name: string // プラグイン名
  appId: string
  startedAt: number // epoch ms
  finishedAt?: number
  stages: PulseStage[]
  totalSeconds?: number
  errors: PulseError[]
  // 「次の一手」などの結果。pane の結果欄に出す(Markdown)。直近1回分だけ
  result?: { title: string; md: string }
  // v1.0 画面チェックのイベント(種類ごと)・読み込み回数・反映直後の縮小(JPEG のパス。中身は pane が読む)
  events?: EventRow[]
  loads?: number
  shots?: { page: ScreenPage; path: string; width: number; height: number; url?: string }[]
  shotNote?: string
}

// ---- フォームの地図 ----
// kin-loop form の返り値(fields + layout)をそのまま持つ。register は加工しない
export type FormField = {
  code: string
  label?: string
  type: string
  required?: boolean
  unique?: boolean
  lookup?: { relatedApp?: { app?: string; code?: string; name?: string }; relatedKeyField?: string } | null
  subtable?: FormField[]
  [k: string]: unknown
}
// kintone の /k/v1/app/form/layout.json の layout(ROW / SUBTABLE / GROUP)
export type LayoutField = { type: string; code?: string; label?: string; elementId?: string; size?: { width?: string; height?: string; innerHeight?: string } }
export type LayoutRow =
  | { type: 'ROW'; fields: LayoutField[] }
  | { type: 'SUBTABLE'; code: string; fields: LayoutField[] }
  | { type: 'GROUP'; code: string; layout: LayoutRow[] }
export type FormMapData = {
  appId: string
  appName?: string
  fields: FormField[]
  // 付いているプラグインと一覧の名前だけ(ID は持たない)。pane の [見る] で出す
  plugins?: string[]
  views?: string[]
  layout?: LayoutRow[] // 無ければ fields の順に1列ずつ並べる
}

// ---- v1.0 プレビューの pane(desktop / mobile / vscode)----
// 色は状態にだけ使う4色(テーマの名前で渡す。アプリの配色に合わせて面が塗る)
export type Tone = 'dev' | 'prod' | 'ok' | 'err'
export const TONE_COLOR: Record<Tone, string> = { dev: 'suggestion', prod: 'warning', ok: 'success', err: 'error' }

// 頭とタイル。register が帯と同じ材料から組む
export type HeadView = {
  appId: string | null
  appName?: string
  kind: 'dev' | 'prod' | null // 接続先の種別。null は未設定
  last: { at: number; seconds: number; ok: boolean } | null // 最後の反映
  errors: number
}

// 画面(反映直後の縮小)。base64 は JPEG。ホスト入りの url は pane の Link にだけ使う(会話・ログに出さない)
export type ScreenPage = 'index' | 'detail' | 'config'
export type ScreenShot = { page: ScreenPage; width: number; height: number; base64: string; url?: string }
export type ScreenView = {
  hasDeploy: boolean // まだ反映が無いなら false(「保存すると、ここに画面が出ます」)
  shots: ScreenShot[] // 撮れた画面だけ(最大3)
  selected: ScreenPage // 今見せている画面
  errors: PulseError[] // 0.9 の鼓動のエラーと同じ
  note?: string // 撮れなかった理由など1行
}

// イベント(kin-probe の pages[].events を種類ごとに足した物)
export type EventRow = { type: string; count: number; handlers: number }
export type EventsView = { rows: EventRow[]; loads: number }

// 本番の関所(小さなダイアログ)
export type GateView = {
  title: string // 例「本番に反映しますか」
  lines: string[] // 何が変わるか3行(プラグイン名と版・対象アプリ・直前の控えの時刻)
  okLabel: string // 反映 / 戻す / 切り替える / 実行
}
