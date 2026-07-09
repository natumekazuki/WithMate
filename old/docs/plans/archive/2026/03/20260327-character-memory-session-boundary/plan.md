# Plan

- 作成日: 2026-03-27
- タスク: Character Memory を main session prompt から外す設計へ更新する

## Goal

- `Character Memory` を main の session prompt 注入対象から外す
- `Character Memory` の用途を monologue / character definition update 側へ寄せる
- 関連 design doc と backlog の記述を矛盾なく揃える

## Scope

- `docs/design/memory-architecture.md`
- `docs/design/product-direction.md`
- `docs/design/monologue-provider-policy.md`
- 必要なら `docs/task-backlog.md`

## Out of Scope

- 実装変更
- retrieval 実装
- Character Stream 実装

## Checks

1. `Character Memory` が main session prompt の常設・必要時注入対象から外れている
2. monologue / character update で使う補助 memory であることが明記されている
3. backlog 上の Memory 関連タスクとの整合が取れている
