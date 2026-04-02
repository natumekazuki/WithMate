# 20260402-memory-generation-timeout-policy

## 目的

- memory generation と character reflection の timeout policy を見直し、モデルや reasoning depth に応じて短すぎる固定値を settings 化して調整可能にする

## スコープ

- current timeout 実装の調査
- provider settings / settings UI / storage schema の拡張
- background provider 実行への timeout 適用
- 回帰 test と docs 同期

## 非スコープ

- monologue API 分離
- memory trigger policy 自体の再設計

## チェックポイント

1. timeout 実装と適用可能範囲を特定
2. settings 化と provider 適用を実装
3. test / docs / backlog / issue を同期
