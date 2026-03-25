# 20260325 memory-prompt-injection-design

## Goal

- Memory を実際の prompt にどう組み込むかの方針を整理する
- `Session / Repository / Character` の 3 層を常設注入と検索注入に分ける

## Scope

- `docs/design/memory-architecture.md` への prompt injection 方針追記
- `docs/design/prompt-composition.md` との責務接続

## Out Of Scope

- 実装
- retrieval 実装
- token budget の細かい最適化

## Steps

1. prompt composition と memory architecture の接点を確認する
2. `memory-architecture.md` に prompt injection policy を追記する
3. plan を閉じる
