# Companion Selected Files History 実装 Decisions

## 2026-04-26

- selected files summary は既存 `companion_sessions` に JSON として保存する。
- 初期表示は Home history card の count と先頭数件の path に限定する。
- changed file summary と sibling warning 永続化は別タスクへ分ける。
