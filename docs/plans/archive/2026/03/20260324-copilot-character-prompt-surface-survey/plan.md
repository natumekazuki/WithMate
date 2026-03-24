# Copilot Character Prompt Surface Survey Plan

## Goal

- Copilot 側で character prompt を main prompt へ直結せずに渡せる経路があるかを確認する
- 現行 SDK surface で実装可能か、別設計が必要かを判断できる状態にする

## Scope

- 現行 `src-electron/copilot-adapter.ts` の prompt 合成点の確認
- install 済み `@github/copilot-sdk` の型定義と RPC surface の確認
- 必要なら公式一次情報で補強する

## Out of Scope

- 実装修正
- Codex 側の prompt 設計変更

## Steps

1. 現行 adapter の character prompt 合成点を特定する
2. Copilot SDK の `SessionConfig` / RPC / custom agent 周辺を確認する
3. main prompt 以外へ載せられる候補を列挙し、実装可否を整理する
