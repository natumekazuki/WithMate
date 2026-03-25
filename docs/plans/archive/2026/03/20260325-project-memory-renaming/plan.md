# 20260325 project-memory-renaming

## Goal

- `Repository Memory` という用語を、Git / NotGit の両方を含む `Project Memory` へ置き換える
- project identity の取り方を docs に明記する

## Scope

- `docs/design/memory-architecture.md` の用語更新
- `Git` と `NotGit` の identity ルール追記

## Out Of Scope

- 実装
- Memory backend 設計
- prompt 注入ロジック変更

## Steps

1. `Repository Memory` 前提の記述を洗い出す
2. `Project Memory` へ改名し、Git / NotGit identity を追記する
3. plan を閉じる
