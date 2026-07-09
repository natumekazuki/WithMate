# Plan

- 作成日: 2026-03-27
- タスク: Memory を含む prompt composition の具体フォーマットを定義する

## Goal

- coding plane で使う prompt の具体フォーマットを定義する
- `Session Memory` の summary 書式を固定する
- `Project Memory` の retrieval 結果をどう挿入するかを固定する
- `Character Memory` を coding plane の prompt 対象外とする前提を `prompt-composition` に反映する

## Scope

- `docs/design/prompt-composition.md`
- 必要なら `docs/design/memory-architecture.md`

## Out of Scope

- 実装変更
- retrieval 実装
- Character Stream 実装

## Checks

1. prompt の論理順序が明記されている
2. `Session Memory` の summary フォーマットが明記されている
3. `Project Memory` の件数上限と section 形式が明記されている
4. `Character Memory` が coding plane prompt の対象外であることが明記されている
