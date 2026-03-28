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
- instruction file には、`character.md` と `character-notes.md` の役割分離、既存ドラフト尊重、更新ルール、自己チェックを含める
- Character Memory は自動注入せず、`Memory Extract` ボタンで貼り付け用テキストを生成して表示する
- `character.md` と `character-notes.md` の分離方針は `docs/design/character-definition-format.md` を前提にする

## UI

- Character Editor から `Update Workspace` を開く
- 専用 window は `SessionWindow` より狭い責務の 2 カラム構成にする
  - 左カラム
    - workspace path
    - provider 選択
    - `Start Update Session`
    - update 対象ファイル一覧
  - 右カラム
    - `LatestCommand`
    - `MemoryExtract`

## Workspace Files

- `character.md`
  - character 定義の正本
- `character-notes.md`
  - 採用理由、出典、保留事項、改稿履歴の退避先
- `AGENTS.md` or `copilot-instructions.md`
  - update 作業用の provider rule

## Provider Rule の優先順位

1. ユーザーが今回与えた更新指示
2. 明示された外部資料や wiki
3. 現在の `character.md`
4. `character-notes.md`
5. Character Memory extract

## Instruction File の責務

- `AGENTS.md` と `copilot-instructions.md` は同じ更新ポリシーを持つ
- `character.md` がコーディングエージェントや対話 AI で使うキャラクターロール定義の正本であることを明示する
- `character.md` を実行時 prompt の正本として扱うことを明示する
- `character.md` 全体が app 側で `# Character` section の本文としてそのまま入ることを明示する
- ユーザーが検索不要と明示していない限り、精度確保に必要な web / wiki 調査を許可する
- 外部調査で採用した根拠を `character-notes.md` へ残すことを明示する
- `character-notes.md` へ退避すべき情報の種類を明示する
- 既存ドラフトを読まずに全消ししないことを明示する
- 更新後に短い変更要約と未確定事項を返すことを明示する

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
- `MemoryExtract` 右ペインから `Refresh / Copy` を行う

## LatestCommand

- Character Update Window 自体は update session を内包しない
- `sessionKind === "character-update"` かつ同一 `characterId` の session を linked session として扱う
- linked session は次の順で選ぶ
  1. `running`
  2. `updatedAt` が新しいもの
- `LatestCommand` は linked session の live run を優先して表示する
- live run が無い時だけ、linked session の main audit log から直近 `command_execution` を補助表示する

## Session 作成

- `workspacePath` は character directory
- `workspaceLabel` は character 名ベースの label を使う
- `taskTitle` は `${character.name} の更新`
- `branch` は実 branch 用の値を使い、用途識別は `sessionKind = "character-update"` で行う
- update session は保存されるが、Home の `Recent Sessions` / `Session Monitor` には出さない
- create / update 保存時に `AGENTS.md` と `copilot-instructions.md` を同期しておく
- update session 起動時は保存済みの instruction file をそのまま使う
- `character-notes.md` は character 保存時に seed され、update task の補助ファイルとして扱う

## Non Goals

- `character.md` の hidden rewrite
- Character Memory の hidden prompt injection
- update session 起動時の自動 web 調査

補足:

- 調査は hidden automation ではなく、Character Update Session 内での agent 作業として行う
