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
  - `workspace / character / approval` を選んで session を起動する

### Character Editor Window

- 1 キャラクターを集中して編集する面
- `name`
- `iconPath`
- `description`
- `roleMarkdown`
- `Save`
- `Delete`

## Design Principles

- Home では `選ぶ` と `開く` に集中する
- 編集フォームは別面へ逃がし、Home の resume 体験を壊さない
- `Delete` は破壊的操作なので Home 常設に置かない
- `Add` は Home から直接始められるようにする
- 編集画面では、入力の意味が自明でないためラベルを許容する
- `Role` は長文前提なので、metadata form と分離した markdown editor 面を持つ

## Interaction Flow

1. Home で `Add Character` を押す
2. `Character Editor Window` が create mode で開く
3. 保存すると character list が更新される
4. Home の `New Session` から新しい character を選べる

既存キャラ編集では次の flow を取る。

1. Home の character card で `Edit` を押す
2. `Character Editor Window` が該当キャラで開く
3. 保存で一覧へ反映する
4. 削除は editor 側からのみ行う

## Mock Scope

- Electron 実行時
  - Main Process の file-based character store を正本とする
  - 保存先は `app.getPath("userData")/characters/`
  - Home / Editor 間は IPC で同期する
- `Role` 入力欄の本文は `character.md` へ保存する
- `Role` は prompt 合成の主要入力であり、一覧メタとは分離して扱う
- 画像パスは save 時に app 専用ディレクトリへコピーする
- 画像選択は renderer の file picker を使い、保存は Main Process が行う
- prompt 合成ルール自体は `docs/design/prompt-composition.md` で管理する

## Next Step

- import / export の導線を設計する
- Home の character list を検索や並び替えに対応させる
- Session 側で character 更新の反映タイミングを詰める
