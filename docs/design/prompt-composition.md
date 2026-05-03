# Prompt Composition

- 作成日: 2026-03-13
- 更新日: 2026-05-03
- 対象: WithMate における coding plane の prompt 合成

## Goal

WithMate が保持する system 指示、character 定義、ユーザー入力を、coding plane の prompt へ安定して渡すための責務分離を定義する。

2026-04-27 時点では、`Session Memory` と `Project Memory` は coding plane prompt に注入しない。過去の prompt 監査で短い依頼ほど Memory section が入力の大半を占め、AI agent の token 効率に対して有益な文脈として働いていないと判断したためである。

2026-05-03 の 4.0.0 方針では、WithMate は完全 SingleMate へ移行する。Mate 定義全文を毎 turn prompt に合成するのではなく、Mate Profile から provider native instruction file へ短い projection を同期する。詳細は `docs/design/single-mate-architecture.md` と `docs/design/provider-instruction-sync.md` を参照する。

## Position

- この文書は coding plane prompt の section 順序と format detail を持つ supporting doc として扱う
- 4.0.0 以降の Mate 定義注入の主経路は `docs/design/provider-instruction-sync.md` を正本にする
- Memory の保存方針は `docs/design/memory-architecture.md` を参照する
- provider 境界は `docs/design/provider-adapter.md` を参照する

## Source Of Truth

### 3.x / current runtime

- キャラクター定義の正本は `character.md`
- `character-notes.md` は prompt 合成へ直接入れない
- Character Editor の `Role` は `character.md` を直接編集する
- `Description` は Home 一覧用メタであり、prompt 合成には使わない
- `System Prompt Prefix` は app 設定の正本として SQLite に保存する
- `Session Memory` / `Project Memory` / `Character Memory` は保存済みデータとして残してよいが、coding plane prompt の入力正本にはしない

### 4.0.0 SingleMate target

- Mate 定義の正本は Mate Profile とする
- `core.md`、`bond.md`、`work-style.md` は provider instruction projection の入力になる
- `notes.md` と Growth Event 履歴は provider instruction projection へ直接入れない
- user prompt には Mate 定義全文を毎 turn 合成しない
- provider instruction sync の成功 / 失敗 / restart 要否は prompt audit と別に記録する

## Composition Layers

### 3.x / current runtime

coding plane に渡す論理 prompt は、次のレイヤーを順に合成して作る。

1. Settings で定義した `System Prompt Prefix`
2. キャラクター `Role` (`character.md`)
3. ユーザー入力

各レイヤーの間には 1 行空けを入れて連結する。アプリ側で section 見出しを自動付与する。

### 4.0.0 SingleMate target

coding plane に渡す turn prompt は、次を基本にする。

1. 必要最小限の WithMate run marker
2. ユーザー入力
3. 添付 reference

Mate Core / Bond Profile / Work Style は provider instruction file へ同期し、毎 turn prompt へ全文合成しない。

## Logical Sections

### 3.x / current runtime

論理 prompt は次の section で構成する。

1. `# System Prompt`
2. `# Character`
3. `# User Input`

`# Session Memory`、`# Project Memory`、`# Character Memory` は coding plane prompt では作らない。

### 4.0.0 SingleMate target

論理 prompt では Mate 定義全文 section を常設しない。

監査用途では次を分けて保存する。

- turn prompt
- provider instruction sync status
- provider instruction projection summary
- transport payload summary

## Section Formats

### `# System Prompt`

- source:
  - `System Prompt Prefix`
- 形式:
  - 設定値をそのまま本文として置く

### `# Character`

- source:
  - `character.md`
- 形式:
  - `character.md` の markdown をそのまま置く
  - app 側が `# Character` を付けるため、`character.md` 本文は `## ...` から始まる構成を推奨する

### `# User Input`

- source:
  - ユーザーがそのターンで送った指示本文
- 形式:
  - 入力本文をそのまま置く

## Memory Injection Policy

### Session Memory

`Session Memory` は現在 prompt に常設しない。

- 保存済み `session_memories` は互換性と将来の再設計余地のために残してよい
- turn 完了時の自動 MemoryGeneration は実行しない
- manual memory generation 操作も現在は no-op とする
- prompt 監査では旧実装の `Session Memory` 常設注入が token 効率を悪化させていたため、再導入する場合は別設計と評価基準を必要とする

### Project Memory

`Project Memory` は現在 prompt に retrieval 注入しない。

- 保存済み `project_memory_entries` は互換性と管理用途のために残してよい
- coding plane prompt への最大 3 件注入は停止する
- 再導入する場合は、ユーザー入力との関連性、重複抑制、token 予算、効果測定を設計し直す

### Character Memory

`Character Memory` は coding plane prompt に入れない。

- 独り言 / character reflection runtime も現在は実行しない
- 保存済み `character_memory_entries` は削除しない

## Cache Strategy

- 3.x の先頭固定部分:
  - `# System Prompt`
  - `# Character`
- 可変部分:
  - `# User Input`

Memory section を可変 prompt から外すことで、短い依頼での token 消費を抑え、provider 側の prompt cache を阻害しにくくする。

4.0.0 では Mate 定義全文も turn prompt から外し、provider instruction sync 側へ移す。これにより WithMate 側の毎 turn prompt 合成を薄くする。ただし provider instruction file が provider context として読まれる場合、token 消費が完全にゼロになるわけではない。

## Responsibility Split

### System Prompt Prefix

`Settings Window` から編集する、アプリ共通の追加 system prompt。

責務:
- キャラクターロール定義の前に必ず入れたい固定指示
- アプリ運用上の追加制約
- 以前の固定システム指示に相当する内容を app 側で持ちたい場合の記述先

非責務:
- キャラクター個別の口調定義
- 1 turn ごとの task 指示

### Character Role

`character.md` の本文そのもの。

責務:
- 口調
- 距離感
- ロールプレイ継続条件
- キャラクターとしての振る舞い
- 実行可能な定義の正本

非責務:
- workspace path
- approval mode
- 一時的な task 指示
- Home 一覧表示用説明
- 採用理由や出典の長い説明

### Character Notes

`character-notes.md` は update workspace 用の補助情報であり、coding plane の prompt 合成対象外。

### User Input

ユーザーがそのターンで送った指示本文。

### Attached References

Session Window の composer では、参照対象は最終的に textarea 内の `@path` を正本にする。

- picker から追加した file / folder / image も textarea に `@path` を挿入する
- 手入力の `@path` も同じ扱いにする
- workspace 外 path は session metadata `allowedAdditionalDirectories` 配下だけを許可する

通常ファイルとフォルダは prompt text へは埋め込まず、session metadata `allowedAdditionalDirectories` とワーキングディレクトリ解決にだけ使う。画像だけは SDK の structured input (`local_image`) で別送する。

## Persisted Prompt Views

監査用途では prompt を次の 2 層に分けて保存する。

- `logicalPrompt`
  - `systemText`
    - `# System Prompt`
    - `System Prompt Prefix`
    - `character.md`
  - `inputText`
    - `# User Input`
    - ユーザー入力本文
  - `composedText`
    - 監査上の論理的な合成表示
- `transportPayload`
  - provider に実際に渡した payload の要約
  - `summary + fields[]` の形で provider ごとの差を持てるようにする

`logicalPrompt` は監査上の論理区分であり、provider 実際の transport と完全一致する必要はない。画像添付や Copilot `systemMessage` のような別送情報は `transportPayload` 側を正本にする。

## Adapter Boundary

Character Editor や storage は `character.md` を保存するだけに留める。実際の prompt 合成は provider adapter 側で担当する。

```ts
type PromptCompositionInput = {
  systemPromptPrefix?: string;
  roleMarkdown: string;
  userMessage: string;
};
```

```ts
type PromptComposition = {
  logicalPrompt: {
    systemText: string;
    inputText: string;
    composedText: string;
  };
};

type PromptComposer = (input: PromptCompositionInput) => PromptComposition;
```

## Current Recommendation

### 3.x / current runtime

- 固定システム指示はアプリ実装にベタ書きしない
- app 共通で必要な固定指示は `System Prompt Prefix` に記述する
- `Role` は system prompt 合成の主要入力として扱う
- `Session Memory` / `Project Memory` / `Character Memory` は coding plane prompt に注入しない
- Codex は `System Prompt -> Character -> User Input` を 1 本の text prompt として組み立てる
- Copilot は `System Prompt Prefix + character.md` を `SessionConfig.systemMessage` に置き、`User Input` を `session.send()` 側へ載せる
- 監査ログでは `logical prompt` と `transport payload` を分けて残し、後から論理指示と実 transport の差を確認できるようにする

### 4.0.0 target

- Mate Profile 全文を毎 turn prompt に合成しない
- Mate Core / Bond Profile / Work Style は provider instruction projection へ圧縮する
- provider instruction sync は session 開始前に実行する
- user prompt には必要最小限の WithMate marker だけを付ける
- audit では turn prompt と provider instruction sync status を分けて残す
- Growth Event 履歴や notes は provider instruction projection へ直接入れない

## UI Impact

- Character Editor では `metadata form` と `character.md` editor を分離する
- `Role` の編集面は markdown editor として広く確保する
- `Description` は editor の metadata 側に残す
- `Settings Window` では `System Prompt Prefix` を編集できるようにする
- `Memory Generation` と `Character Reflection` の設定 UI は表示しない
- `character-notes.md` は Character Editor と update workspace から扱えるが、coding plane の editor 本体とは分離する
- 4.0.0 では Character Editor を Mate Profile へ置き換え、provider instruction sync status を表示する

## Open Questions

- Memory を将来再導入する場合の評価指標と token 予算
- provider ごとに prompt composer を分けるか
- provider instruction sync 後の restart required を provider adapter と Settings のどちらで持つか
