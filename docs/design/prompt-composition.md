# Prompt Composition

- 作成日: 2026-03-13
- 更新日: 2026-03-27
- 対象: WithMate における coding plane の prompt 合成

## Goal

WithMate が保持する system 指示、character 定義、memory、ユーザー入力を、coding plane の prompt へ安定注入するための責務分離を定義する。

## Position

- この文書は coding plane prompt の section 順序と format detail を持つ supporting doc として扱う
- prompt に注入する Memory の全体方針は `docs/design/memory-architecture.md` を参照する
- provider 境界は `docs/design/provider-adapter.md` を参照する

## Source Of Truth

- キャラクター定義の正本は `character.md`
- `character-notes.md` は prompt 合成へ直接入れない
- Character Editor の `Role` は `character.md` を直接編集する
- `Description` は Home 一覧用メタであり、prompt 合成には使わない
- `System Prompt Prefix` は app 設定の正本として SQLite に保存する
- `Session Memory` の正本は `session_memories`
- `Project Memory` の正本は `project_memory_entries`
- `Character Memory` は coding plane の prompt 合成には使わない

## Composition Layers

coding plane に渡す論理 prompt は、次のレイヤーを順に合成して作る。

1. Settings で定義した `System Prompt Prefix`
2. キャラクター `Role` (`character.md`)
3. `Session Memory` summary
4. 必要時に検索した `Project Memory`
5. ユーザー入力

各レイヤーの間には 1 行空けを入れて連結する。
アプリ側で section 見出しを自動付与する。

## Logical Sections

論理 prompt は次の section で構成する。

1. `# System Prompt`
2. `# Character`
3. `# Session Memory`
4. `# Project Memory`
5. `# User Input`

ただし `# Project Memory` は retrieval hit がある時だけ出す。  
`Character Memory` 用 section は coding plane では作らない。

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

### `# Session Memory`

- source:
  - `SessionMemoryV1`
- policy:
  - 毎 turn 常設する
  - 空欄の field は section 内で省略する
  - `notes` は長くなりやすいので、必要なら下位優先で truncate する
- 形式:

```md
# Session Memory

Goal:
- <goal>

Decisions:
- <decision 1>
- <decision 2>

Open Questions:
- <open question 1>

Next Actions:
- <next action 1>

Notes:
- <note 1>
```

- field rule:
  - `Goal` は 1 項目だけ
  - `Decisions` は最大 5 件
  - `Open Questions` は最大 5 件
  - `Next Actions` は最大 5 件
  - `Notes` は最大 3 件

### `# Project Memory`

- source:
  - `Project Memory` retrieval hit
- policy:
  - 常設しない
  - retrieval hit がある時だけ付与する
  - 最大 3 件まで
  - category と本文だけを簡潔に出す
  - current 実装では `userMessage + SessionMemory.goal + SessionMemory.openQuestions` から token を作り、`title / detail / keywords` との lexical match で retrieval する
- 形式:

```md
# Project Memory

- [decision] <text>
- [constraint] <text>
- [context] <text>
```

- field rule:
  - 1 entry は 1 bullet
  - category label は残す
  - path や source session id などの storage metadata は入れない

### `# User Input`

- source:
  - ユーザーがそのターンで送った指示本文
- 形式:
  - 入力本文をそのまま置く

## Cache Strategy

- 先頭の固定部分:
  - `# System Prompt`
  - `# Character`
- 可変部分:
  - `# Session Memory`
  - `# Project Memory`
  - `# User Input`

この構成により、固定部分の cache 利用を阻害しにくくしつつ、memory と今回の依頼を後段に載せられる。

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

責務:
- 調査メモ
- 採用理由
- 出典
- 未確定事項

非責務:
- main prompt の直接入力

### User Input

ユーザーがそのターンで送った指示本文。

### Session Memory

`Session Memory` は作業継続の骨格として扱う。

責務:

- 現在の目的を維持する
- この session で確定した判断を維持する
- 未解決論点と次アクションを維持する

非責務:

- project 全体の durable knowledge
- character 関係性の補助

### Project Memory

`Project Memory` は必要時だけ取り出す補助知識として扱う。

責務:

- project 固有の方針や過去判断を補う
- 今回の依頼と関係がある durable knowledge を補う

非責務:

- 毎 turn 常設すること
- session の短期メモを持つこと

### Character Memory

`Character Memory` は coding plane の prompt 合成対象外とする。

責務:

- monologue / character update 側の入力に使う

非責務:

- main の coding session prompt に入ること

### Attached References

Session Window の composer では、参照対象は最終的に textarea 内の `@path` を正本にする。

- picker から追加した file / folder / image も textarea に `@path` を挿入する
- 手入力の `@path` も同じ扱いにする
- workspace 外 path は session metadata `allowedAdditionalDirectories` 配下だけを許可する

`@path` は送信時に解決するだけでなく、入力中も workspace 内の file path 候補を表示して補助する。
候補一覧は軽量 cache を使って高速化するが、cache には TTL を持たせ、session run 完了後は invalidate して生成直後の file が反映されやすいようにする。

通常ファイルとフォルダは prompt 内の参照情報として列挙する。画像だけは SDK の structured input (`local_image`) で別送する。
通常ファイルとフォルダは prompt text へは埋め込まず、session metadata `allowedAdditionalDirectories` とワーキングディレクトリ解決にだけ使う。
画像は `@path` が textarea に残っている場合にだけ `local_image` として送る。textarea から消えた画像 path は送信対象から外れる。

## Persisted Prompt Views

監査用途では prompt を次の 2 層に分けて保存する。

- `logicalPrompt`
  - `systemText`
    - `# System Prompt`
    - `System Prompt Prefix`
    - `character.md`
  - `inputText`
    - `# User Input Prompt`
    - ユーザー入力本文
  - `composedText`
    - 監査上の論理的な合成表示
- `transportPayload`
  - provider に実際に渡した payload の要約
  - `summary + fields[]` の形で provider ごとの差を持てるようにする

`logicalPrompt` は監査上の論理区分であり、provider 実際の transport と完全一致する必要はない。
画像添付や Copilot `systemMessage` のような別送情報は `transportPayload` 側を正本にする。

`logicalPrompt` では section の論理順序を保持する。  
provider ごとの transport では、この順序を保ちながら system 側と user input 側に分配してよい。

## Adapter Boundary

Character Editor や storage は `character.md` を保存するだけに留める。
実際の prompt 合成は Codex adapter 側で担当する。

```ts
type PromptCompositionInput = {
  systemPromptPrefix?: string;
  roleMarkdown: string;
  sessionMemorySummary?: string;
  projectMemoryEntries?: Array<{
    category: string;
    text: string;
  }>;
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

- 固定システム指示はアプリ実装にベタ書きしない
- app 共通で必要な固定指示は `System Prompt Prefix` に記述する
- `Role` は system prompt 合成の主要入力として扱う
- `Session Memory` は coding plane の骨格として毎 turn 注入する
- `Project Memory` は retrieval hit がある時だけ最大 3 件まで注入する
- `Character Memory` は coding plane では使わず、monologue / character update 側へ分離する
- current 実装では、Codex は `System Prompt -> Character -> Session Memory -> Project Memory -> User Input` を 1 本の text prompt として組み立てる
- current 実装では、Copilot は `System Prompt Prefix + character.md` を `SessionConfig.systemMessage` に置き、`Session Memory + Project Memory + User Input` を `session.send()` 側へ載せる
- 監査ログでは `logical prompt` と `transport payload` を分けて残し、後から論理指示と実 transport の差を確認できるようにする

## UI Impact

- Character Editor では `metadata form` と `character.md` editor を分離する
- `Role` の編集面は markdown editor として広く確保する
- `Description` は editor の metadata 側に残す
- `Settings Window` では `System Prompt Prefix` を編集できるようにする
- `character-notes.md` は Character Editor と update workspace から扱えるが、coding plane の editor 本体とは分離する

## Open Questions

- provider ごとに prompt composer を分けるか
  - 現状は共通 `logicalPrompt` を持ちつつ、transport だけ provider-specific に分ける方針
- `Session Memory` の各 field の件数上限を実運用でどこまで絞るか
- `Project Memory` retrieval に時間減衰や semantic retrieval をどこまで足すか
