# Character Management UI

- 作成日: 2026-03-12
- 対象: `Home Window` と `Character Editor Window` の責務分離

## Goal

キャラクター管理を `Home Window` に無理に詰め込まず、
`Home Window` では一覧と起動導線だけを担い、
作成・編集・削除は `Character Editor Window` へ分離する。

## Window Split

### Home Window

- `Recent Sessions`
  - `codex resume` 相当の再開判断を担う
- `Characters`
  - 利用可能キャラクターの一覧を表示する
  - 各カードは `avatar / name / short description / Edit` に絞る
  - 0 件なら empty state と `Add Character` だけを出す
- `Add Character`
  - 新規キャラ作成用の `Character Editor Window` を開く
- `New Session`
  - `title / workspace / character` を選んで session を起動する

### Character Editor Window

- 1 キャラクターを集中して編集する面
- `name`
- `iconPath`
- `description`
- `theme colors`
  - `main`
  - `sub`
  - color picker + hex + RGB 入力
- `roleMarkdown`
- `Save`
- `Delete`

## Design Principles

- Home では `選ぶ` と `開く` に集中する
- 編集フォームは別面へ逃がし、Home の resume 体験を壊さない
- `Delete` は破壊的操作なので Home 常設に置かない
- `Add` は Home から直接始められるようにする
- 編集画面では、入力の意味が自明でないためラベルを許容する
- `character.md` は長文前提なので、metadata form と分離した editor 面を持つ
- `Character Editor` は `Profile / システムプロンプト` の 2 モードで切り替え、長文の `character.md` がフォーム面を圧迫しないようにする
- Character Editor の基本配色は `Home` と同じ dark base を使い、キャラカラーは次段でアクセント用途へ限定していく
- Character Editor では `main` を active tab / focus / primary action、`sub` を preview と各カードの補助ラインに使う
- `Save / Delete` は画面下部の action bar に固定し、本文は header / footer の間だけスクロールする
- `Profile / システムプロンプト` の tabs は content カードの外に置くが、背景色や固定レールは付けない
- content カードは header / tabs / footer を除いた残り高さを常に使い切り、`Profile` と `character.md` で高さ感を揃える
- `character.md` タブも `Profile` と同じ content レイアウト定義を使い、残り高さを editor に割り当てる
- `システムプロンプト` タブでは、`character.md` の説明と editor を同じカードにまとめる
- `character.md` タブには「キャラクター定義の正本であり、プロンプト合成に使われる」説明を表示し、説明ブロックは `Profile` と同じ文脈で読めるカードとして扱う
- `Profile` 側は content カード内でスクロールし、`Theme` などの下部要素がカード外へはみ出さないようにする
- `Profile` 側のスクロールバー有無で幅が揺れないように、scroll gutter を固定する
- top の preview は window 高さに関わらず同じレイアウトを維持し、avatar サイズや theme swatch 位置を動かさない

## Interaction Flow

1. Home で `Add Character` を押す
2. `Character Editor Window` が create mode で開く
3. 保存すると character list が更新される
4. Home の `New Session` から新しい character を選べる

既存キャラ編集では次の flow を取る。

1. Home の character card 全体を押す
2. `Character Editor Window` が該当キャラで開く
3. 保存で一覧へ反映する
4. 削除は editor 側からのみ行う

## Mock Scope

- Electron 実行時
  - Main Process の file-based character store を正本とする
  - 保存先は `app.getPath("userData")/characters/`
  - `userData` は `<appData>/WithMate/` に固定する
  - Home / Editor 間は IPC で同期する
- `character.md` の本文はそのまま保存する
- `character.md` は prompt 合成の主要入力であり、一覧メタとは分離して扱う
- 画像パスは save 時に app 専用ディレクトリへコピーする
- 画像選択は renderer の file picker を使い、保存は Main Process が行う
- prompt 合成ルール自体は `docs/design/prompt-composition.md` で管理する

## Next Step

- import / export の導線を設計する
- Home の character list を検索や並び替えに対応させる
- Session 側で character 更新の反映タイミングを詰める
