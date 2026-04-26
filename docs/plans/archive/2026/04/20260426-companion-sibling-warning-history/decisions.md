# Companion Sibling Warning History 実装 Decisions

## 2026-04-26

- sibling warning は `companion_sessions` に JSON として保存し、専用 table は追加しない。
- 保存する warning は merge 完了時に発生した warning のみとし、discard では空配列にする。
- 履歴カードには warning 件数と先頭 warning の対象 session / path summary を表示する。
