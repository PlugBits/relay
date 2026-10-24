# プラグイン作成 mod

kintone のプラグインを Claude Code で作る mod — PlugBits

**English summary.** plugin builder mod for Claude Code: build kintone plugins from chat. It runs the kintone plugin development loop: save a file, the mod packs it, uploads it, adds it to a kintone app, then opens the app in a headless browser and sends console errors back to Claude. In plain language you can ask Claude to make, deploy, configure, check and undo a kintone plugin. Requires Claude Code 2.1.287 or later, Node 20+ and a kintone admin account. Use a throwaway trial app first. Production apps need a human confirmation for every write, and the mod sends nothing to PlugBits (no telemetry). The rest of this README is in Japanese.

## これは何か

kintone のプラグイン開発を Claude Code で回す mod です。ファイルを保存すると、pack → アップロード → アプリに追加 → 反映まで進み、画面で出たエラー(console.error・未捕捉例外・kintone.events の発火順)が Claude に戻ります。

自然言語で「作る・反映する・設定する・確かめる・戻す」ができます。操作は `/kin` コマンドと、Claude が呼ぶ道具 `kin_*` の 2 通りです。

## 前提

- Claude Code 2.1.287 以降
- 端末(ターミナル)
- Node 20 以上
- kintone の管理者アカウント(サブドメイン・ログイン名・パスワード)

**お試し用のアプリを1つ作ってから始めてください。既存のアプリには入れないでください。** 最初は開発モード(後述)で、お試しアプリだけに反映します。

## 入れ方

Claude Code の入力欄で次を打ちます。

```
/plugin install plugbits-relay --marketplace PlugBits/relay
```

表示される確認は順に次のとおりです。

1. `Add marketplace?`(`github:PlugBits/relay`)… `y`
2. プラグインの説明と「Make sure you trust a plugin…」の注意、スコープの選択 … user(自分の全作業)/ project(このリポジトリの全員)/ local(このリポジトリの自分だけ)から選んで Enter
3. `✓ Installed plugbits-relay. Plugin is now active.`

シェルからなら `claude plugin install plugbits-relay --marketplace PlugBits/relay` でも入ります。

### Claude デスクトップアプリで入れる場合

デスクトップアプリのチャット欄で `/plugin install` を打っても、開くのは画面のプラグイン一覧だけで、入りません。ターミナルで次の 2 行を順に実行してください。

```
claude plugin marketplace add PlugBits/relay
claude plugin install plugbits-relay@plugbits-relay --scope user
```

- Claude Code が 2.1.287 より古いと、`Hook load failed: expected record at hooks` と出ます。`claude update` で更新してください。
- デスクトップアプリの入力欄に `/kin はここでは使用できないコマンドです` と出ても、コマンドは届いて動きます。無視して大丈夫です。

依存(`node_modules`)は導入の時に Claude Code が入れます。続けて `/kin doctor` を打ち、`deps` が OK なら準備完了です。もし `deps` が NG なら、直し方の行に出るとおり端末で次を一度だけ実行してください(この mod が自分で入れることはありません)。

```
cd <プラグインのフォルダ> && npm ci --omit=dev
```

画面チェック(ブラウザでの確認)を使うなら、必要に応じて次も実行します。画面チェックが無くても反映は動きます(画面チェックだけ「省略」になります)。

```
npx playwright install chromium
```

ブラウザが別の場所にある端末では、環境変数で教えます。

- `RELAY_CHROMIUM` … chromium の実行ファイルのパス
- `RELAY_NATIVE_LIBS` … ブラウザが必要とする共有ライブラリのフォルダ(あれば実行時に足します)

## 設定

接続先は `/kin setup` で作り、`~/.config/tiny-pulse/kintone/*.env`(権限 600)に保存されます。切り替えは pane の頭の「開発 ▾ / 本番 ▾」か `/kin use <id>` です。

`/kin setup` を実行すると、接続設定の pane が開きます。

1. pane の操作は、デスクトップアプリならクリックです。ターミナルなら ctrl+x → Tab → Tab で入力欄に入ります(1つ目の欄=名前に入ります)
2. Tab で次の欄へ進みます
3. パスワード欄か本番のアプリ番号の欄で Enter を押すと保存されます([保存] ボタンでも同じ)。空の必須欄があれば赤字で知らせ、保存しません。保存すると「/kin use <id> で切り替え」が出ます
4. 入力中の文字は画面に見えます(会話には残りません)

項目は、名前・サブドメイン・ドメイン・ログイン名・パスワード・種別(開発/本番)・本番に反映してよいアプリ番号です。

保存しただけでは接続先は切り替わりません。`/kin use <id>` を打つか、pane の「使う」ボタンを押してください。今の接続先は `/kin status`、動作条件の診断は `/kin doctor` です。

## スマホ(Remote Control)から使う

スマホ側には pane が出ません。`/kin setup` は端末で済ませてください。そのあとは、自然言語の依頼と `/kin <アプリ番号>`、`/kin ok` がスマホからも使えます。

## コマンド

- `/kin` … 作業台の pane を開く(反映先が未選択なら「はじめに」: 作る/直す/接続先)
- `/kin setup` … 接続設定(pane の入力欄。デスクトップ版でも同じ)
- `/kin use <id>` … 接続先の切り替え(本番は確認つき)
- `/kin status` … 今の接続先
- `/kin doctor` … 動作条件の診断(何も入れない)
- `/kin connect` … アプリ一覧
- `/kin <アプリ番号>` … フォームを見て、反映先にする。以後 `plugins/<name>/` の保存で自動反映
- `/kin undo [アプリ番号]` … 直前の反映を控えから戻す
- `/kin ok` / `/kin cancel` … 本番の確認待ちを進める/やめる
- `/kin next <番号>` … 反映の後の「次の一手」を選ぶ(番号だけを送っても同じ)

### 反映の後の「次の一手」

反映が終わると、会話と pane に番号つきで次の選択肢が出ます。選び方は 3 通りです。

- 番号を送る(例: `3`)… Claude の手番を使わずに、その場で動きます
- pane のボタンを押す … 番号を送るのと同じです
- 言葉で頼む … Claude が続けます

デスクトップアプリでは、結果が会話と pane の結果欄の両方に出ます。

1 画面で見る(一覧・詳細の URL) / 2 設定を変える(設定画面の URL) / 3 見た目を見る(設定と一覧の縮小1枚。1プラグイン1回) / 4 もう1本作る / 5 戻す / 6 本番に入れる(開発環境の時だけ。切り替えの手順) / 7 終わる(配布用の zip を `plugins/<name>/dist/` に作る) / 8 試験データを片付ける(`kin_records_write` で作ったレコードがある時だけ)

番号は固定です。今は選べない物も「(今は無し)」として同じ番号のまま出ます。

本番の確認待ちの間は出ません(先に「反映 / やめる」)。

## pane で見えるもの(v1.1)

デスクトップ版・スマホ・VS Code の pane は、上から次の順に並びます。
- **頭**: アプリ名と「開発 ▾ / 本番 ▾」のボタン。押すと接続先の一覧(名前・開発/本番・ドメイン)と [使う]・[接続先を追加] が開きます。
- **はじめに**: 反映先がまだ決まっていない時だけ、カード3枚(新しくプラグインを作る・既存のプラグインを直す・接続先を変える)を出します。アプリやプラグインを選ぶと、頼み方の下書きが入力欄に入ります。会話の最初の返事も同じ3択になります。
- **数字のタイル3つ**: 反映の秒数・エラー件数(0 は緑・1 以上は赤)・最後の反映の時刻。
- **作る・直す**: 反映先を選んだ後、まだ反映していなければ画面の位置にカード2枚(このアプリに新しく作る/付いているプラグインを直す)を出します。反映の後は、次の一手の行の先頭に同じ2つの小さなボタンを置きます。
- **画面**: 反映の直後に撮った kintone の画面の縮小です。一覧・詳細・設定を切り替えられ、下に「kintone で開く」があります。エラーがあれば、ファイルと行・1行の説明・[直す] を出します。[直す] を押すと修正の依頼が入力欄に入ります。
- **イベント**: kintone.events の種類ごとに、発火と登録の回数を横バーで出します。発火の多い順に5行で、残りは「▸ 他 n 件」に畳みます。
- **フォーム**: kintone の行の並びのまま、欄をボタン(チップ)で出します。押すとフィールドコードが入力欄に入ります。
- **次の一手**: 番号つきのボタンです(今は選べない番号は出しません)。押した結果は枠のカード1枚に出し、URL は「開く ↗」のリンクにします。
- **詳細**: 畳んであり、付いているプラグイン・一覧の名前と反映の経過が入っています。

足元の帯には、接続先・アプリ・最後の反映を出します。エラーは 1 件以上の時だけ赤く出ます。反映の直後 60 秒は [戻す] が出ます。

本番への反映は、pane の上の小さな確認で止まります。確認には何が変わるか(プラグインと版・対象アプリ・直前の控えの時刻)を出し、[反映] を押すまで何もしません。Esc で閉じると、やめた扱いになります。

ターミナルでは、同じ内容を文字の版で出します。

## 道具(Claude が使う kin_* 13 個+試験中 1 個)

- 読むだけ: `kin_status`(接続先の状態)・`kin_apps`(アプリ一覧)・`kin_form`(フィールド。ルックアップの参照先・キー・コピー先、重複禁止、既定値、関連レコードも)・`kin_plugins`(付いているプラグインと JS/CSS)・`kin_records`(レコードを最大 20 件)・`kin_probe`(画面チェック)・`kin_backups`(控えの一覧)
- `kin_probe` の操作(`actions`): 1ページで手順を順に流します。開く(`open`: detail / index / config / create / edit・レコード番号)・押す(`click`: 文字か role と名前)・入れる(`fill`)・選ぶ(`select`)・キー(`press`)・保存(`save`)・待つ(`expect` / `wait`)・読む(`read`)。欄はラベルで探し、kintone の内部 DOM は使いません。返り値は手順ごとの成否、開いたレコードの番号と URL、最後の画面の文字(ダイアログ本文・ボタン名・項目名)、events の発火回数・登録数・読み込み回数。縮小1枚は1回の呼び出しで最大1枚(2コマ・1コマ 540px)。入れる・押す・保存は開発環境だけで、本番では断ります。
- 試験データ(開発環境だけ・本番は断る): `kin_records_write`(最大 20 件をタグつきで作り、作った番号を控えに記録)・`kin_records_cleanup`(記録した番号だけ消す)
- フォームを変える(試験中。`RELAY_FORM_CHANGE=1` で起動した時だけ出ます。開発環境だけ・本番は断る): `kin_form_change`(欄の追加・ラベル変更・ルックアップの付与・レイアウトの行の追加)。先に変更の一覧を出し、人の確認(pane のボタンか `/kin ok`)を1回待ってから反映します。欄の削除とルックアップの解除はしません。
- 作る: `kin_scaffold`(`plugins/<name>/` にひな形。ローカルのファイルだけ)。kind は次の5つ:
  - `event` … events の型(保存前・表示時の処理を書く)
  - `config-only` … 設定画面と、設定を読むだけの本体
  - `header-button` … 一覧のヘッダーにボタン、押すと小さなパネル
  - `index-band` … 一覧の上の帯に、絞り込み中の件数と、選んだ数値フィールドごとの合計(出す一覧も選べる)
  - `detail-notice` … レコード詳細で、選んだフィールドのどれかが空なら注意書き
- 書く(本番は人の確認待ち): `kin_deploy`(pack→反映→画面チェック。開発環境では `appId` に `65,53` のように複数並べると、プラグイン本体の更新は1回・アプリへの反映はまとめて1回)・`kin_undo`(戻す)・`kin_customize`(プラグインでない JS/CSS の設定)

### ビルドの段

`plugins/<name>/relay.config.json` に `"build": { "command": "npm run stage:dev", "dir": "plugins/<name>-dev" }` を書くと、保存の自動反映と `kin_deploy` は先に command を作業フォルダで実行し、`dir` を包んで反映します。command が失敗したら反映せず、出力の末尾 20 行を返します。`dir` の中の保存では自動反映しません。`build` 以外のキーは今までどおり設定値です。

## 作られる物の見た目

Claude が作るプラグインは、最初から kintone 標準の見た目で出ます。設定画面は kintone 公式の 51-modern-default.css(kintone-samples/plugin-samples・MIT)を同梱し、`kintoneplugin-*` のクラスだけで組みます(項目名・必須・説明・フィールドの選択・入力・注意書き・右下に「キャンセル」「保存」)。本体は同梱の小さな部品 relay-ui の4つ(ヘッダーのボタン・一覧の上の帯・詳細の注意書き・小さなパネル)を使い、色・影・角丸を足しません。文言は機能名で、製品名や会社名は画面に出しません。ひな形の型は上の `kin_scaffold` の5つの kind から選べます。

設定画面の項目は同梱の部品 relay-config で組みます。フィールドの選択(1つはドロップダウン・複数はチェックボックス。型で絞れる。サブテーブルの中の欄は「テーブル名 › 欄」)・一覧の選択(「すべての一覧」も)・アプリの選択・選択肢の値・数値と文字の入力(必須・上限下限・既定値。空や範囲外は赤字で止める)・行の追加と削除。フィールドコードや一覧を文字で打たせません。Claude が `relay.config.json` で入れた設定値は、前回と同じなら次の反映で送り直さないので、画面で選び直した値が残ります。この mod が有効な間、この決まりは Claude のシステムプロンプトに1節として入ります。反映後、Claude は `kin_probe` の `screenshots: true` で設定・詳細・一覧を並べた縮小画像を1回だけ見て、崩れがあれば直します。

## 守り

- **開発と本番を分けます。** 本番モードで書き込めるのは、設定に載せたアプリ番号だけです。載っていないアプリは止まります。本番への書き込みは毎回、人の確認(pane のボタン、または `/kin ok`)を待ちます。確認できる道具はありません。Claude 自身は確認を進められません。
- **反映の前に毎回、控えを取ります。** `/kin undo` で戻せます。戻せないものは、正直に「戻せません」と出します。アプリからプラグインを外す操作には公式 API が無く、戻せません。customize の FILE 指定のものも戻せません。
- **パスワードは** `~/.config/tiny-pulse/kintone/*.env`(権限 600)にだけ置きます。会話には入れません。pane・道具の結果・次の発話のどこにも出さない作りです。
- **Bash の見張り**: Claude が Bash から接続設定の保存や切り替え、反映を直接行うのを止めます。必ずこの mod の道具(kin_*)を通り、本番の確認が人に残ります。
- **kintone の内部 DOM には触りません。** 公式の REST API とイベントだけを使います。
- **作者には何も送りません。** テレメトリはありません。通信先はあなたの kintone だけです(画面チェックのブラウザも、そのアプリを開くだけ)。

## できないこと・限界

- アプリからのプラグインの取り外しと、その取り消しはできません(公式 API が無い)。
- customize の FILE 指定の取り消しはできません。
- SSO や 2 要素認証のある環境では画面チェックにログインできません。「画面チェックは省略(ログイン不可・反映は済)」と返します。反映は通ります。
- 画面チェックには chromium が要ります。無い環境では省略になります。
- スマホでは pane が出ません。
- 反映は 60 秒、画面チェックは 120 秒(操作つきは 240 秒)、ビルドは 200 秒で打ち切り、「時間切れ」と返します。どこまで進んだかは `/kin <アプリ番号>` で確かめてください。
- 例の記述は example.cybozu.com・アプリ 42 のようなダミーです。自分の環境の値に読み替えてください。

## ライセンス

MIT(LICENSE を参照)。作者: PlugBits

同梱の `tools/assets/51-modern-default.css` は Cybozu の著作物で、MIT License です(ファイル冒頭の表記のまま同梱)。
