# Decisions

- キャンセルは provider 側の graceful cancellation を使う。
- キャンセル後の session は `runState = idle` に戻す。
- 監査ログ phase は `canceled` を追加し、errorMessage でユーザーキャンセルを明示する。
