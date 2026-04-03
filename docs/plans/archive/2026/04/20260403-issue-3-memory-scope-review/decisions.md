# Decisions

## Decision 1

- status: confirmed
- decision: `#3` は「Memory 基盤」と「monologue / character 応用」を分けて評価する
- rationale:
  - issue 本文は session / character memory の永続化と monologue 用コンテキスト抽出を求めている
  - current 実装では Memory 基盤はかなり揃っており、残タスクは主に `#1` と `#15` の応用層に寄っているため

## Decision 2

- status: confirmed
- decision: current の残論点は `#3` 単独ではなく `#1` `#15` `memory-management-manual-update` `#38` へ分解して扱うのが自然
- rationale:
  - `Memory` の保存・昇格・retrieval・管理 UI 基盤は既に存在する
  - 残っているのは monologue plane の provider 方針、memory extraction と monologue の統合、管理 UI の拡張であり、別テーマとして検討しやすい
