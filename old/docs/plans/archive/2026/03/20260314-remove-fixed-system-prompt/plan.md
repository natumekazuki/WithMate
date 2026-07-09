# Plan

## Goal

- 固定システム指示を撤去し、必要な固定指示は Settings の `System Prompt Prefix` に含める仕様へ切り替える

## Scope

- prompt composition の実装変更
- 監査ログ上の system prompt の意味更新
- 関連 Design Doc / 実機テスト項目表の更新

## Task List

- [x] prompt composition から固定システム指示を削除する
- [x] 関連 docs を current behavior に更新する
- [x] 検証する
