# Copilot SystemMessage Character Prompt Plan

## Goal

- Copilot では character prompt を main prompt 文字列へ直結せず、session-level `systemMessage` へ分離する
- user message 本文は `session.send({ prompt })` に寄せ、character 指示と transport 上の責務を分ける
- audit では「画面上の prompt 表示」と「Copilot への実際の渡し方」の差が追える状態を作る

## Scope

- `src-electron/copilot-adapter.ts` の session config 組み立てを更新する
- `src-electron/provider-prompt.ts` または provider-specific prompt composition を見直す
- Copilot の session cache key に `systemMessage` 内容を反映する
- audit log に残す prompt 系フィールドの扱いを整理する
- 関連 design doc と manual test を更新する

## Out of Scope

- Codex 側の prompt composition 変更
- character 定義フォーマット自体の見直し
- custom agent prompt と character prompt の統合

## Intended Changes

1. Copilot では `systemPromptPrefix + character.roleMarkdown` を `SessionConfig.systemMessage` へ載せる
2. Copilot の `session.send()` には user input 中心の text prompt を送る
3. Codex は現状の `composedPromptText` 経路を維持する
4. audit では provider ごとの差が読めるよう、必要なら prompt 表示の意味付けを再定義する

## Risks

- session cache が `systemMessage` 変更を拾わず古い session を再利用する可能性
- audit log が「実際に transport へ渡した text」とズレて読みにくくなる可能性
- Copilot の `systemMessage` と custom agent prompt の相互作用で期待と違う persona になる可能性

## Steps

1. 現行 prompt / audit write-path の差分を実装観点で棚卸しする
2. Copilot 向け `systemMessage` 生成と `session.send()` の text 分離を実装する
3. session cache key / resume 条件 / audit 出力を整合させる
4. テストと docs を更新する
5. `npm run build` と必要なテストを実行する
