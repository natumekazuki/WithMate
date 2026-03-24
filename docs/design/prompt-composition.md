# Prompt Composition

- 作成日: 2026-03-13
- 対象: WithMate における Codex 実行時の prompt 合成

## Goal

WithMate が保持するキャラクター定義を、Codex 実行時の prompt へ安定注入するための責務分離を定義する。

## Source Of Truth

- キャラクター定義の正本は `character.md`
- Character Editor の `Role` は `character.md` を直接編集する
- `Description` は Home 一覧用メタであり、prompt 合成には使わない
- `System Prompt Prefix` は app 設定の正本として SQLite に保存する

## Composition Layers

Codex に渡す最終 prompt は、次のレイヤーを順に合成して作る。

1. Settings で定義した `System Prompt Prefix`
2. キャラクター `Role` (`character.md`)
3. ユーザー入力

各レイヤーの間には 1 行空けを入れて連結する。
アプリ側で `# System Prompt` と `# User Input Prompt` を自動付与する。
`System Prompt Prefix` や `character.md` 個別の見出しは自動付与しない。

## Responsibility Split

### System Prompt Prefix

Settings overlay から編集する、アプリ共通の追加 system prompt。

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

非責務:
- workspace path
- approval mode
- 一時的な task 指示
- Home 一覧表示用説明

### User Input

ユーザーがそのターンで送った指示本文。

### Attached References

Session Window の composer では、参照対象は最終的に textarea 内の `@path` を正本にする。

- picker から追加した file / folder / image も textarea に `@path` を挿入する
- 手入力の `@path` も同じ扱いにする

`@path` は送信時に解決するだけでなく、入力中も workspace 内の file path 候補を表示して補助する。
候補一覧は軽量 cache を使って高速化するが、cache には TTL を持たせ、session run 完了後は invalidate して生成直後の file が反映されやすいようにする。

通常ファイルとフォルダは prompt 内の参照情報として列挙する。画像だけは SDK の structured input (`local_image`) で別送する。
通常ファイルとフォルダは prompt text へは埋め込まず、`additionalDirectories` とワーキングディレクトリ解決にだけ使う。
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

## Adapter Boundary

Character Editor や storage は `character.md` を保存するだけに留める。
実際の prompt 合成は Codex adapter 側で担当する。

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

- 固定システム指示はアプリ実装にベタ書きしない
- app 共通で必要な固定指示は `System Prompt Prefix` に記述する
- `Role` は system prompt 合成の主要入力として扱う
- 現行の Codex SDK 実装では adapter が `# System Prompt + (System Prompt Prefix + character.md) + # User Input Prompt + user input` を空行区切りで 1 本の text として組み立て、画像がある場合だけ structured input で `thread.run()` へ渡す
- 現行の Copilot SDK 実装では adapter が `System Prompt Prefix + character.md` を `SessionConfig.systemMessage` `mode: "append"` に載せ、`session.send()` には user input 本文だけを渡す
- 監査ログでは `logical prompt` と `transport payload` を分けて残し、後から論理指示と実 transport の差を確認できるようにする

## UI Impact

- Character Editor では `metadata form` と `character.md` editor を分離する
- `Role` の編集面は markdown editor として広く確保する
- `Description` は editor の metadata 側に残す
- Settings overlay では `System Prompt Prefix` を編集できるようにする

## Open Questions

- provider ごとに prompt composer を分けるか
  - 現状は共通 `logicalPrompt` を持ちつつ、transport だけ provider-specific に分ける方針
