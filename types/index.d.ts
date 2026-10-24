export type RelayLine = {
  text: string
  tone?: 'head' | 'ok' | 'err' | 'dim'
}

declare module 'claude-code' {
  interface PluginState {
    'plugbits-relay': {
      // 現在の対象アプリ(/kin <appId> で設定)
      target: string
      // 上段: アプリ一覧 / フォーム
      main: Shaped<RelayLine[]>
      // 下段: 反映・probe の経過
      loop: Shaped<RelayLine[]>
      // 次のプロンプトに添える「mod からの報告」(1 行)
      report: string
      // ② pane と同じ内容の短い Markdown(次のプロンプトの context に載せる)
      digest: Shaped<{ kind: string; md: string }[]>
      // ① 本番への反映/undo/customize の確認待ち(JSON 文字列。空なら無し。人の入力だけが確定できる)
      confirm: string
      // 接続先のモード('dev' | 'prod')
      envMode: string
      // /kin setup の pane の見た目(JSON 文字列。パスワードは入れない)
      setup: string
      // 反映の後の「次の一手」(JSON 文字列。空なら無し。appId・名前・plugin ID・origin・mode・見た印だけ。認証情報・設定値は入れない)
      next: string
      // v0.9 反映の鼓動(JSON 文字列 Pulse。直近1回分だけ。空なら無し。ホスト・パス・認証情報は入れない)
      pulse: string
      // v0.9 フォームの地図(JSON 文字列 FormMapData。/kin <appId> で読んだ反映先アプリの fields + layout)
      formMap: string
      // v0.9 足元の帯の接続先(JSON 文字列 {name, kind})。ホスト名・ログイン名は入れない
      conn: string
      // v0.9.1 pane の畳んだ行のうち開いている物('plugins' | 'views' | 空)
      formOpen: string
      // v1.0 pane の見た目(JSON 文字列 {screen, form, all, detail, evAll, conn, pick})
      paneUi: string
      // v1.0 反映の直後 60 秒だけ帯に [戻す] を出すアプリ番号(空なら出さない)
      undoOffer: string
      // v1.1 はじめに(反映先が未選択の時の段。JSON 文字列 StartStep。アプリ番号・名前とプラグイン名だけ)
      start: string
    }
  }
}
