# Plan

- 作成日: 2026-03-28
- タスク: Character Memory 基盤の仕様を固定する

## Goal

- `Character Memory` の責務を `関係性記憶` に限定する
- `Character Memory` と `独り言` の生成タイミングを共通化する
- 保存先、抽出入力、出力、trigger の設計を固定する

## Scope

- `docs/design/memory-architecture.md`
- `docs/design/monologue-provider-policy.md`
- `docs/design/product-direction.md`
- `docs/design/character-memory-storage.md`
- `docs/task-backlog.md`

## Out Of Scope

- 実装
- API key 保存
- monologue UI の本実装

## Checks

1. `Character Memory` が作業知識と混ざらない方針になっている
2. `Character Memory` と `独り言` の trigger が共通化されている
3. 保存先と更新フローが docs 上で追える
