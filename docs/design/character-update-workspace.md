# Character Update Workspace

## 目的

- `character.md` の改善作業を、character ごとの保存ディレクトリを workspace にして行えるようにする
- WithMate は更新支援に徹し、更新内容の最終判断はユーザーと通常の agent session に委ねる

## 方針

- workspace は `character storage directory` をそのまま使う
- `character update session` は通常の Session Window で開く
- provider ごとに update 作業用の instruction file を配置する
  - Codex: `AGENTS.md`
  - Copilot: `copilot-instructions.md`
- instruction file は character 保存時に character directory へ同期しておく
- Character Memory は自動注入せず、`Memory Extract` ボタンで貼り付け用テキストを生成して表示する

## UI

- Character Editor から `Update Workspace` を開く
- 専用 window には最低限これを置く
  - workspace path
  - provider 選択
  - `Start Update Session`
  - `Extract Memory`
  - extract 結果の read-only 表示
  - `Copy`

## Workspace Files

- `character.md`
  - character 定義の正本
- `AGENTS.md` or `copilot-instructions.md`
  - update 作業用の provider rule

## Provider Rule の優先順位

1. ユーザーが今回与えた更新指示
2. 明示された外部資料や wiki
3. 現在の `character.md`
4. Character Memory extract

## Character Memory Extract

- model は使わず deterministic に整形する
- source は `character_memory_entries`
- category ごとに grouped markdown を返す
  - `relationship`
  - `preference`
  - `tone`
  - `boundary`
  - `shared_moment`
- 各項目は `title: detail` の bullet を基本とする
- `evidence` は存在する時だけ短く添える
- extract は更新用 prompt へ手動で貼り付ける前提で、説明文は最小限にする

## Session 作成

- `workspacePath` は character directory
- `workspaceLabel` は character 名ベースの label を使う
- `taskTitle` は `${character.name} の更新`
- `branch` は固定の logical label を使う
- create / update 保存時に `AGENTS.md` と `copilot-instructions.md` を同期しておく
- update session 起動時は保存済みの instruction file をそのまま使う

## Non Goals

- `character.md` の hidden rewrite
- Character Memory の hidden prompt injection
- update session 起動時の自動 web 調査
