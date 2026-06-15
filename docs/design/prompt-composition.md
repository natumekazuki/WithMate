# Prompt Composition

- 作成日: 2026-03-13
- 更新日: 2026-06-15
- 対象: WithMate における coding plane の prompt 合成

## Goal

WithMate が保持する system 指示、character 定義、ユーザー入力を、coding plane の prompt へ安定して渡すための責務分離を定義する。

2026-04-27 時点では、`Session Memory` と `Project Memory` は coding plane prompt に注入しない。過去の prompt 監査で短い依頼ほど Memory section が入力の大半を占め、AI agent の token 効率に対して有益な文脈として働いていないと判断したためである。

2026-06-14 の V5 Character Core では、複数 Character catalog を current runtime へ戻し、session / companion 開始時点の `CharacterRuntimeSnapshot.definitionMarkdown` を coding plane の system 側へ注入する。Character snapshot は、ファイル操作や test/build の正確性を置き換える作業 policy ではなく、ユーザー向け自然言語レスポンスの人格・話し方・温度・反応パターンの正本として扱う。`character-notes.md`、Memory / Growth history、provider instruction sync 由来の Character 書き込みは常設 prompt に入れない。

## Position

- この文書は coding plane prompt の section 順序と format detail を持つ supporting doc として扱う
- V5 Character Core の Character 注入境界は `docs/design/character-storage.md` と `docs/design/character-definition-format.md` を正本にする
- Memory の保存方針は `docs/design/memory-architecture.md` を参照する
- provider 境界は `docs/design/provider-adapter.md` を参照する

## Source Of Truth

### current runtime

- Character 定義の runtime 正本は session / companion に保存された `CharacterRuntimeSnapshot` とする
- `character.md` snapshot は system 側に入れ、主にユーザーへ説明する言葉、相槌、励まし、ツッコミ、距離感、温度へ反映する
- prompt 合成時は `character.md` の frontmatter を除いた本文だけを渡し、Character section の固定説明は最小限にする
- ファイル操作、コマンド実行、検索、diff 確認、test/build 結果、repository instruction は通常の coding agent として正確に扱う
- `character-notes.md` は保存してよいが、runtime 常設 prompt には入れない
- app 共通 system prompt を Settings で編集する仕組みは持たない
- `Session Memory` / `Project Memory` / `Character Memory` は保存済みデータとして残してよいが、coding plane prompt の常設入力正本にはしない
- provider instruction sync は V5 Character 注入の主経路にしない

### 4.0.0 SingleMate target

- Mate 定義の正本は Mate Profile とする
- `core.md`、`bond.md`、`work-style.md` は provider instruction projection の入力になる
- `notes.md` と Growth Event 履歴は provider instruction projection へ直接入れない
- user prompt には Mate 定義全文を毎 turn 合成しない
- provider instruction sync の成功 / 失敗 / restart 要否は prompt audit と別に記録する

## Composition Layers

### current runtime

coding plane に渡す turn prompt は、次のレイヤーを基本にする。

1. `CharacterRuntimeSnapshot.definitionMarkdown`
2. 必要最小限の WithMate run marker
3. ユーザー入力
4. 添付 reference

Character snapshot は session / companion 開始時点の保存済み値を使い、catalog の現在値へ追従しない。app 共通 system prompt は挿入しない。
provider に渡す `Character Definition Snapshot` では、保存済み snapshot の frontmatter は除外し、`character.md` 本文だけを markdown block として囲む。

### 4.0.0 SingleMate target

coding plane に渡す turn prompt は、次を基本にする。

1. 必要最小限の WithMate run marker
2. ユーザー入力
3. 添付 reference

Mate Core / Bond Profile / Work Style は provider instruction file へ同期し、毎 turn prompt へ全文合成しない。

## Logical Sections

### current runtime

論理 prompt では `Character Definition Snapshot` section を system 側に置く。

`# Session Memory`、`# Project Memory`、`# Character Memory` も coding plane prompt では作らない。

### 4.0.0 SingleMate target

論理 prompt では Mate 定義全文 section を常設しない。

監査用途では次を分けて保存する。

- turn prompt
- provider instruction sync status
- provider instruction projection summary
- transport payload summary

## Section Formats

### `# User Input`

- source:
  - ユーザーがそのターンで送った指示本文
- 形式:
  - `# User Input` 見出しの下に入力本文をそのまま置く
  - Character Definition Snapshot や Project Context の直後でも、ここからがユーザー入力であることを明示する

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

- 固定的な Mate 定義は provider instruction sync 側へ移す
- turn prompt の可変部分は `# User Input` と添付 reference に寄せる

Mate 定義全文と Memory section を毎 turn prompt から外すことで、短い依頼での token 消費を抑え、provider 側の prompt cache を阻害しにくくする。ただし provider instruction file が provider context として読まれる場合、token 消費が完全にゼロになるわけではない。

## Responsibility Split

### Character Runtime Snapshot

session / companion 開始時点の `character.md`。

責務:
- ユーザー向け自然言語レスポンスで使う Character 定義
- audit / prompt boundary で確認できる system 側の Character section
- catalog 更新後も既存 session が同じ人格定義を使うための保存境界

非責務:
- `character-notes.md`
- Memory / Growth history
- provider instruction sync への書き込み
- Character 定義自動生成
- coding agent としてのファイル操作、検索、diff 確認、test/build 結果の正確性を置き換える作業 policy

### Provider Instruction Projection

V4 SingleMate 由来の legacy / deferred 経路。V5 Character Core では Character 注入の主経路にしない。

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
    - provider instruction projection の要約
    - app 共通 system prompt は空
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

Mate Profile や storage は構造化された Mate 定義を保存する。実際の provider instruction projection と turn prompt 合成は provider adapter 境界で担当する。

```ts
type PromptCompositionInput = {
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

### current runtime

- 固定システム指示は app settings に持たない
- `CharacterRuntimeSnapshot.definitionMarkdown` を system 側へ注入する
- provider instruction sync は Character 注入の主経路にしない
- `Session Memory` / `Project Memory` / `Character Memory` は coding plane prompt に注入しない
- Codex は user input と structured reference を provider-native input として渡す
- Copilot は provider instruction file を前提にし、`User Input` を `session.send()` 側へ載せる
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
- `Settings Window` では V5 Character の raw editor / import / default / archive を扱う
- `Memory Generation` と `Character Reflection` の設定 UI は表示しない
- `character-notes.md` は Character Editor と update workspace から扱えるが、coding plane の editor 本体とは分離する

## Open Questions

- Memory を将来再導入する場合の評価指標と token 予算
- provider ごとに prompt composer を分けるか
- provider instruction sync 後の restart required を provider adapter と Settings のどちらで持つか
