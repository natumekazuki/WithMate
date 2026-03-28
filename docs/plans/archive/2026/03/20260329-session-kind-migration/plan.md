# Plan

- 状態: 進行中
- 目的: branch と用途を分離するため sessionKind を追加し、既存 DB を migration で維持する
- 範囲:
  - Session shared state
  - session storage migration
  - character update session 作成
  - Home 表示判定
  - docs / test
- 検証:
  - build
  - session-storage / home-session-projection / character-update-workspace test

