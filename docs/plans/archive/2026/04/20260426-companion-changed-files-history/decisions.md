# Companion Changed Files History 実装 Decisions

## 2026-04-26

- changed file summary は path と kind だけを既存 `companion_sessions` に JSON として保存する。
- diff rows / file contents は保存しない。
- selected files summary とは分け、all changed files の概要として表示する。
