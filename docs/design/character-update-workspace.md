# Character Update Workspace

## 目的

- `character.md` の改善作業を、character ごとの保存ディレクトリを workspace にして行えるようにする
- WithMate は更新支援に徹し、更新内容の最終判断はユーザーと通常の agent session に委ねる

## 方針

- workspace は `character storage directory` をそのまま使う
- `character update session` は専用 window ではなく `Session Window` の `character-update` variant で開く
- Character Update Session の基本操作は通常の Session と同じにしつつ、更新用途に不要な UI は削る
- update は自然言語指示を中心に進め、追加 UI や hidden automation に依存しない
- fixed workflow は workspace 内 skill として置き、provider ごとの instruction file はその skill を前提にする
- provider ごとに update 作業用の instruction file を配置する
  - Codex: `AGENTS.md`
  - Copilot: `copilot-instructions.md`
- `skills/character-definition-update/SKILL.md` を character 保存時に character directory へ同期しておく
- instruction file は character 保存時に character directory へ同期しておき、詳細ルールは skill 側を参照する
- Character Memory は自動注入せず、`Memory Extract` ボタンで貼り付け用テキストを生成して表示する
- `character.md` と `character-notes.md` の分離方針は `docs/design/character-definition-format.md` を前提にする

## UI

- Character Editor から `Open Update Workspace` を押す
- Character Editor 内で、Home の `New Session` に近い launch modal を開く
  - 固定の session title
  - 固定 workspace path
  - provider 選択
  - `Start Update Session`
- provider 選択後はそのまま `character-update session` を作成して `Session Window` を開く
- update 開始前の専用 monitor window や専用 renderer window は持たない

### Session Window Variant

- `sessionKind === "character-update"` の時だけ `Session Window` を update 向け variant で描画する
- main の message area と composer の基本操作感は通常 session と同じにする
- header
  - 残す: `Audit Log`, `Close`
  - 削る: `Terminal`, `More`
- right pane
  - `LatestCommand`
  - `MemoryExtract`
- footer / composer
  - 通常の添付と送信操作は残す
  - `Skill` picker と `Agent` picker は出さない

補足:

- composer、添付、送信の操作感は通常の Session Window と揃える
- 追加の専用フォームは持たず、更新内容、調査方針、参照したい source は自然言語で agent に伝える

## Workspace Files

- `character.md`
  - character 定義の正本
- `character-notes.md`
  - 採用理由、出典、保留事項、改稿履歴の退避先
- `character.png`
  - character と対になる代表画像
- `skills/character-definition-update/SKILL.md`
  - 更新 workflow の正本
- `AGENTS.md` or `copilot-instructions.md`
  - provider ごとの薄い導入ルール

## Provider Rule の優先順位

1. ユーザーが今回与えた更新指示
2. 明示された外部資料や wiki
3. 現在の `character.md`
4. `character-notes.md`
5. Character Memory extract

## Instruction File の責務

- `AGENTS.md` と `copilot-instructions.md` は同じ更新ポリシーを持つ
- workspace 内の `character-definition-update` skill を前提に作業することを明示する
- `character.md` がコーディングエージェントや対話 AI で使うキャラクターロール定義の正本であることを明示する
- `character.md` を実行時 prompt の正本として扱うことを明示する
- `character.md` 全体が app 側で `# Character` section の本文としてそのまま入ることを明示する
- `character.png` を paired asset として扱い、必要なら取得 / 更新することを明示する
- 詳細な更新手順、調査方針、自己チェックは skill 側へ寄せる

## Skill の責務

- `character-definition-update` skill は update workflow の正本とする
- 次を明示する
  - `character.md` / `character-notes.md` の役割分離
  - 既存ドラフト尊重
  - 外部調査の許可範囲と source 優先順位
  - `character.md` に残すものと `character-notes.md` に逃がすもの
  - 自己チェック
- Character Update Session は自然言語指示中心で進め、skill は固定 workflow を支える裏のルールとして扱う

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
- session 起動後に必要な場合だけ、別の補助導線から利用する

## Natural Language Update Workflow

Character Update Session では、次のような自然言語指示で作業を進めることを想定する。

1. 目的を伝える
   - 例: `このキャラの口調をもっと原作寄りにしたい`
   - 例: `character.md を新規作成したい`

2. 調査の要否を伝える
   - 例: `必要なら web も見て`
   - 例: `今回は検索せず、今ある定義だけで直して`

3. 必要なら source を渡す
   - 例: `この wiki を優先して`
   - 例: `添付した設定資料を見て`

4. agent が更新する
   - `character.md` の定義更新
   - 必要に応じて `character-notes.md` に根拠や保留を記録

5. 更新結果を確認する
   - Session の diff / command で変更内容を見る
   - 必要なら追加で自然言語指示を出して反復する

## External Research Policy

- 外部調査は hidden automation ではなく、Character Update Session 内での agent 作業として行う
- ユーザーが `検索不要` と明示していない限り、agent は定義の精度確保に必要な範囲で web / wiki を参照してよい
- 調査は「常に行う」のではなく、「現在の定義だけでは精度が足りない時に行う」を基本にする
- 外部資料の優先順位は `公式 / 一次情報に近い資料 / 出典付き wiki / その他` とする
- 単独の弱い source だけで中核定義を更新しない
- 採用した根拠、競合した解釈、保留事項は `character-notes.md` に残す
- `character.md` には調査ログを膨らませず、最終的に採用した定義だけを残す
- `character.png` を更新した場合の採用理由や source は `character-notes.md` に残す

## Session 作成

- `workspacePath` は character directory
- `workspaceLabel` は character 名ベースの label を使う
- `taskTitle` は `${character.name} の更新`
- `branch` は実 branch 用の値を使い、用途識別は `sessionKind = "character-update"` で行う
- update session は保存されるが、Home の `Recent Sessions` / `Session Monitor` には出さない
- create / update 保存時に `AGENTS.md`、`copilot-instructions.md`、`skills/character-definition-update/SKILL.md` を同期しておく
- update session 起動時は保存済みの instruction file をそのまま使う
- `character-notes.md` は character 保存時に seed され、update task の補助ファイルとして扱う
- `character.png` は既存 asset があれば維持し、session 内で新規取得または更新してよい

## Non Goals

- `character.md` の hidden rewrite
- Character Memory の hidden prompt injection
- update session 起動時の自動 web 調査

補足:

- 調査は hidden automation ではなく、Character Update Session 内での agent 作業として行う
