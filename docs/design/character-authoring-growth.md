# Character Authoring And Improvement

- 作成日: 2026-06-16
- 対象: V5 Character Core 後の `character.md` / `character-notes.md` 作成・改善支援

## Goal

`character.md` を agent で作成・改善できる authoring / improvement 機構を、現行 V5 の prompt 境界を壊さずに追加する。

この文書は、V3 由来の Character Update Workspace と外部 authoring Skill を参考にしながら、V5 以降で採用する責務境界、agent flow、保存境界、MVP slice を固定する。旧 Character Update Workspace の runtime variant は廃止済みとする。

## Position

- `character.md` format の正本は `docs/design/character-definition-format.md`。
- storage / snapshot の正本は `docs/design/character-storage.md`。
- coding plane prompt 合成の正本は `docs/design/prompt-composition.md`。
- 旧 Character Update Workspace の runtime variant は廃止済みであり、この文書を新しい implementation entry とする。
- Memory / Growth 非連携の境界は `docs/design/memory-architecture.md` と `docs/design/mate-growth-engine.md` を参照する。

## Core Decisions

- `character.md` は runtime 正本として維持する。
- `character-notes.md` は runtime prompt の常設入力にしない。根拠、解釈、改稿理由、再導入しない判断、未確認事項を置く authoring-side note として扱う。
- `character.md` 本文は person-first にする。本文内で対象を `Character`、`キャラクター`、`persona`、作られた役として説明せず、本人らしさ、口調、距離感、反応、温度として定義する。
- authoring Skill は character runtime に直埋めしない。WithMate は `withmate-character-authoring` の固定 skill template を app 管理し、authoring session では常にその skill を使う。
- 外部 Skill zip は app 管理 template の入力候補として扱えるが、session ごとにユーザーが Skill を選ぶ操作は持たない。
- authoring session の provider は起動前に選択できる。Skill / Agent は固定だが、provider 選択は通常 session 作成と同じ runtime 選択として扱う。
- 自動作成・自動改善は hidden rewrite にしない。ユーザーが authoring session を起動した時だけ agent が編集する。
- 既存定義の更新は全文再生成より差分更新を優先する。
- 旧 `Character Memory` や Growth history を `character.md` の作成・改善入力にしない。会話履歴からの自動改善は初期 scope に含めない。
- `character.md` の frontmatter は管理 metadata として保持する。provider prompt に入れる際の frontmatter 除去は prompt composition 側の責務であり、authoring 成果物からは削除しない。

## Product Flow

### Create From Scratch

1. Character Editor で `Author with Agent` を押す。
2. ユーザーが名前、短い説明、元資料、希望する距離感、調査可否を指定する。
3. WithMate は authoring workspace を作り、template を seed する。
4. Agent が `character.md`、`character-notes.md` を作成する。
5. まだ `characterId` がない新規作成中は `Author with Agent` を使用不可にする。
6. Character を保存して `characterId` が確定した後に authoring session を開始できる。

### Improve Existing Definition

1. Character Editor で対象 Character から `Improve with Agent` を押す。
2. 保存済み `characters/<character-id>/` を authoring workspace として開く。
3. ユーザーが改善目的を自然言語で伝える。
4. Agent は `character.md` を差分更新し、根拠、保留、採用しなかった案、戻すべきでない旧記述を `character-notes.md` に残す。
5. 既存 Character の authoring では、agent が `characters/<character-id>/character.md` / `character-notes.md` を直接更新する。

## Workspace Boundary

既存 Character の authoring workspace は Character storage directory そのものとする。agent は `characters/<character-id>/` 配下の `character.md` / `character-notes.md` を直接編集する。

```text
characters/
  <character-id>/
    character.md
    character-notes.md
    AGENTS.md
    AUTHORING_PROMPT.md
    input.json
    <provider-skill-root>/withmate-character-authoring/
```

理由:

- apply / discard 導線なしで、agent の編集結果をそのまま WithMate runtime に反映できる。
- Character Editor / Session runtime が同じ `character.md` を見るため、正本と authoring draft の同期処理を持たなくてよい。
- workspace path が実データの場所になるため、ユーザーがファイルを確認しやすい。

制約:

- agent の途中書き込みは即座に正本ファイルへ入る。
- `character.md` が一時的に invalid でも runtime snapshot はその本文を読めるため、authoring 中の通常 session 確認は未完成内容を反映しうる。
- agent が補助ファイルを増やす場合、Character storage directory に残る。WithMate 管理の補助ファイルは `AGENTS.md` / `AUTHORING_PROMPT.md` / `input.json` / provider skill directory に限定する。
- 次回 authoring 起動時に `AGENTS.md` / `AUTHORING_PROMPT.md` / `input.json` は上書きし、provider skill directory は削除してから app 管理 skill を再コピーする。
- DB metadata の `name` / `description` / `updated_at` は markdown 直接編集だけでは自動更新されない。Character Editor は file 再読込時に `character.md` frontmatter を editor draft へ反映し、Save 時に frontmatter の `name` / `description` を SQLite metadata へ保存する。

Character catalog へ保存する対象は次に限定する。

- `character.md`
- `character-notes.md`
- managed icon
- SQLite metadata

Source notes、review notes、asset notes、revision log、do-not-reintroduce decisions は必要に応じて `character-notes.md` に統合する。authoring workspace では、runtime 正本に取り込まれない補助 artifact を増やさない。

## Agent Runtime

Authoring / improvement は通常 Session の派生として扱う。

- `sessionKind = "character-authoring"` を追加する。
- 新規作成と既存改善はどちらも `character-authoring` を使う。
- 基本 UI は Session Window を再利用し、独自 chat layout は作らない。
- 右 pane は `LatestCommand`、`DiffPreview`、`ValidationIssues` を持つ。
- Composer は通常の添付を残すが、Skill picker / Agent picker は出さない。
- Character Editor は authoring 起動前に provider を選択できる。model / reasoning effort は作成された Session Window の通常 runtime controls で変更する。
- Authoring session は app 管理の `withmate-character-authoring` skill を固定で使う。ユーザーが skill を選ぶ操作は持たない。
- WithMate は authoring workspace 作成時に固定 skill と provider instruction を seed し、初回 prompt でもその skill の使用を明示する。

Provider は Codex / Copilot の既存 session adapter を使う。

- Codex は workspace の `AGENTS.md` と `.agents/skills/withmate-character-authoring` から固定 authoring skill を読む。
- Copilot は workspace の `AGENTS.md` と `.github/skills/withmate-character-authoring` から固定 authoring skill を読む。
- Provider 固有の実行差分は Session adapter に閉じ込める。
- Agent は catalog storage API を直接呼ばない。workspace file を直接編集する。

## Fixed Skill Contract

App 管理 skill の正本名は `withmate-character-authoring` とする。

Run workspace には次を seed する。

- Codex provider: `.agents/skills/withmate-character-authoring/SKILL.md`
- Copilot provider: `.github/skills/withmate-character-authoring/SKILL.md`
- `withmate-character-authoring/templates/character.md`
- `withmate-character-authoring/templates/character-notes.md`

Provider instruction は、起動直後に必ずこの skill を使うこと、成果物は workspace 内の files として作ること、catalog storage API を直接呼ばないことを明示する。

初回 prompt は WithMate が生成し、次を含める。

- fixed skill name
- selected provider
- create / improve の mode
- target files
- user instruction
- 既存 Character では編集結果がそのまま正本ファイルへ反映されること

ユーザー入力は authoring 目的や source 指示に限定し、Skill 選択、agent 選択、runtime prompt 注入設定は触らせない。

## Run Lifecycle

既存 Character の authoring run は直接編集として扱う。

```text
created
  -> running
  -> completed | failed
```

- `created`: workspace と fixed skill template を seed した状態。
- `running`: provider session が workspace files を編集している状態。
- `completed`: provider run が終了し、正本ファイルが更新済みの状態。
- `failed`: provider run、validation、workspace read/write のいずれかが失敗した状態。

新規 Character でまだ `characterId` がない場合は authoring session を開始しない。起動前に Character を保存して `characterId` を確定させる。

## Instruction Template

Instruction は薄く保ち、詳細は app 管理 skill template へ寄せる。

必須方針:

- `character.md` は runtime response layer の正本である。
- `character.md` 本文に WithMate 実装、prompt 注入、provider 同期、notes/report/source policy の説明を書かない。
- 本文では person-first に書く。
- 作業能力や検証の正確性は通常の coding agent として維持し、本人らしさはユーザーへ見える説明、相槌、距離感、温度へ反映する。
- `character-notes.md` には source、rights、uncertainty、採用理由、競合解釈、保留事項、改稿履歴、再導入しない判断を置く。
- `character.md` は短く実行可能な定義へ保ち、調査ログや長い引用を入れない。
- 既存 `character.md` がある場合は差分更新を優先する。

## Validation Gates

### Pre-save Gate

- `character.md` の schema / name / body / size / null byte / path safety validation。
- `character-notes.md` の size / null byte validation。
- `character.md` 本文に明らかな authoring meta が混入していないかを rule check する。
- `Character`、`persona`、`ロールプレイ` などの禁止語は hard error ではなく warning にする。固有名詞や引用で必要な場合があるため。
- frontmatter が消えていないかを確認する。

### Review Gate

- validation では `character.md` と `character-notes.md` を別々に確認する。
- `character.md` に source / rights / uncertainty / 長い調査ログが入っている場合は warning を出す。
- `character-notes.md` に runtime へ常設注入される前提の文がある場合は warning を出す。
- `character.md` 本文に `WithMate`、`prompt`、`runtime`、`notes`、`report`、`このファイル`、`注入` などの authoring meta が残る場合は warning を出す。
- icon / asset の取り込みは managed icon へ materialize する前に path safety と size を確認する。

### Direct Edit Gate

- 既存 Character の authoring は CharacterStorage の apply API を通さず、file workspace を直接編集する。
- 既存 session の `CharacterRuntimeSnapshot` は session turn 開始時に最新 file から再解決する。
- 失敗時もすでに書き込まれた file は残る。必要なら `character-notes.md` に取り消し理由を残す。

## Improvement Boundary

Improvement はユーザー起動時だけ `character.md` を直接更新する。

```text
current character files
  -> character directory workspace
  -> agent edit
  -> future session turns read latest files
```

保存済み Character Memory や Growth Event は、初期 scope では authoring workspace に渡さない。prompt composition は session snapshot の `character.md` だけを使う。

自動反映を将来検討する場合でも、次は MVP では禁止する。

- `character.md` の hidden rewrite
- `core` / 本人の芯に当たる定義の自律変更
- source 不明の外部情報による中核定義更新
- 忘却済み内容の再導入
- current session snapshot の途中差し替え
- session / companion 会話履歴からの自動改善

## MVP Slices

1. Authoring artifact format alignment
   - app 管理 template を person-first 構成へ更新する。
   - `character-definition-format.md` の recommended structure を `Presence Priority` / person-first 方針へ合わせる。

2. Authoring workspace
   - 既存 Character では `characters/<character-id>/` を workspace として使う。
   - 新規 Character では保存して `characterId` が確定するまで authoring を使用不可にする。

3. Agent authoring session
   - `sessionKind = "character-authoring"` を追加し、Session Window で authoring run を開く。
   - app 管理の `withmate-character-authoring` skill を固定で seed / invoke し、既存 provider adapter と workspace files だけで agent に生成させる。

4. Validation / refresh
   - `character.md` / `character-notes.md` を validate できるようにする。
   - Character Editor と Session runtime は最新 file を読む。

## Non Goals

- Skill / ChatGPT Project の WithMate runtime 直埋め。
- `character-notes.md` の runtime 常設 prompt 注入。
- Memory / Growth history の自動 prompt 注入。
- session / companion 会話履歴からの `character.md` 自動改善。
- user selectable authoring skill / agent picker。
- authoring 起動前の model / reasoning effort picker。
- user action なしの `character.md` 自律保存。
- 専用 chat layout の新設。
- source の権利判定や外部情報の正確性保証。

## Tests

- `characterId` 未確定の新規 Character では authoring session を開始できない。
- 既存 Character から authoring run を作ると `characters/<character-id>/` を workspace にする。
- authoring session の turn 開始時に最新 Character file snapshot を使う。
- authoring artifact に絶対 path が保存されない。
- authoring run が固定 `withmate-character-authoring` skill を seed する。
- authoring session の初回 prompt が fixed skill 使用と catalog storage API 直接利用禁止を含む。
- Skill picker / Agent picker が authoring session に出ない。
- Character Editor から選択した provider で authoring session が作成される。
- session / companion 会話履歴が authoring workspace に自動 materialize されない。
- warning と hard error の項目が分かれる。

## Deferred

- 外部 authoring Skill zip を app 管理 template として import / update する UI。
- LLM による authoring quality validator。
- authoring run の長期履歴管理、検索、比較。
- session / companion 会話履歴を明示選択して改善材料にする flow。
