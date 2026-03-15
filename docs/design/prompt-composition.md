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

Session Window の composer では、次の 2 経路で参照対象を追加できる。

- picker から追加した file / folder / image
- textarea で指定した `@path`

`@path` は送信時に解決するだけでなく、入力中も workspace 内の file path 候補を表示して補助する。

通常ファイルとフォルダは prompt 内の参照情報として列挙する。画像だけは SDK の structured input (`local_image`) で別送する。
通常ファイルとフォルダは prompt text へは埋め込まず、`additionalDirectories` とワーキングディレクトリ解決にだけ使う。

## Persisted Prompt Views

監査用途では prompt を次の 3 つに分けて保存する。

- `systemPromptText`
  - `# System Prompt`
  - `System Prompt Prefix`
  - `character.md`
- `inputPromptText`
  - `# User Input Prompt`
  - ユーザー入力本文
- `composedPromptText`
  - 実際に `thread.run()` へ渡す text 部分の最終文字列

これらは監査上の区分であり、実際に送る文字列も同じ構造を持つ。
画像添付がある場合は `composedPromptText` が text 部分になり、画像本体は structured input で別送される。

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
  systemPromptText: string;
  inputPromptText: string;
  composedPromptText: string;
};

type PromptComposer = (input: PromptCompositionInput) => PromptComposition;
```

## Current Recommendation

- 固定システム指示はアプリ実装にベタ書きしない
- app 共通で必要な固定指示は `System Prompt Prefix` に記述する
- `Role` は system prompt 合成の主要入力として扱う
- 現行の Codex SDK 実装では adapter が `# System Prompt + (System Prompt Prefix + character.md) + # User Input Prompt + user input` を空行区切りで 1 本の text として組み立て、画像がある場合だけ structured input で `thread.run()` へ渡す
- 監査ログでは `system / input / composed` を分けて残し、後から差分を確認できるようにする

## UI Impact

- Character Editor では `metadata form` と `character.md` editor を分離する
- `Role` の編集面は markdown editor として広く確保する
- `Description` は editor の metadata 側に残す
- Settings overlay では `System Prompt Prefix` を編集できるようにする

## Open Questions

- provider ごとに prompt composer を分けるか
