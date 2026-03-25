# 20260325 memory-architecture-reframing

## Goal

- Memory を `Repository / Session / Character` の 3 層で定義し直す
- `Repository` と `Session` の違いを current milestone 向けに明文化する

## Scope

- `docs/design/memory-architecture.md` の再整理
- Memory の共有範囲、昇格ルール、内部処理方針の明文化

## Out Of Scope

- Memory 実装
- LangGraph 導入
- Monologue 実装

## Steps

1. 既存の Memory 設計と current の product direction を確認する
2. `memory-architecture.md` を 3 層前提で再定義する
3. plan を閉じて次に詰める論点を残す
