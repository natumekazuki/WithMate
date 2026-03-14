# Prompt Composition

- 作成日: 2026-03-13
- 対象: WithMate における Codex 実行時の prompt 合成

## Goal

WithMate が保持するキャラクター定義を、Codex 実行時の prompt へ安定注入するための責務分離を定義する。

## Source Of Truth

- キャラクター定義の正本は `character.md`
- Character Editor の `Role` は `character.md` を直接編集する
- `Description` は Home 一覧用メタであり、prompt 合成には使わない

## Composition Layers

Codex に渡す最終 prompt は、次のレイヤーを順に合成して作る。

1. 固定システム指示
2. キャラクター `Role` (`character.md`)
3. session / workspace に応じた補助コンテキスト
4. ユーザー入力

## Responsibility Split

### Fixed System Instructions

WithMate 側で固定的に持つ、実行制御と安全上の指示。

例:
- UI / adapter の動作ルール
- 出力整形ルール
- セッション管理上の制約

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

### Session Context

セッション再開や workspace 状態に紐づく補助情報。

例:
- workspace path
- branch
- session summary
- 直近の決定事項

### User Input

ユーザーがそのターンで送った指示本文。

## Adapter Boundary

Character Editor や storage は `character.md` を保存するだけに留める。
実際の prompt 合成は Codex adapter 側で担当する。

```ts
type PromptCompositionInput = {
  fixedSystemPrompt: string;
  roleMarkdown: string;
  sessionContext?: string;
  userMessage: string;
};
```

```ts
type PromptComposer = (input: PromptCompositionInput) => string;
```

## Current Recommendation

- MVP では `Role` を raw system prompt と同一視しない
- `character.md` は system prompt 合成の主要入力として扱う
- 固定システム指示は adapter 側に残し、キャラ定義と混ぜて保存しない
- 現行の Codex SDK 実装では adapter が composed prompt を 1 本作って `thread.run()` へ渡す

## UI Impact

- Character Editor では `metadata form` と `character.md` editor を分離する
- `Role` の編集面は markdown editor として広く確保する
- `Description` は editor の metadata 側に残す

## Open Questions

- 固定システム指示をどのファイルに置くか
- session context の注入粒度をどこまで上げるか
- provider ごとに prompt composer を分けるか
