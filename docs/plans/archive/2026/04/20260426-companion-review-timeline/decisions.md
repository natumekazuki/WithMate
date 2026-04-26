# Companion Review Timeline 実装 Decisions

## 2026-04-26

- timeline は `companion_merge_runs` の全件を新しい順で表示する。
- timeline では operation、created_at、selected files、changed files、sibling warning 件数を表示する。
- timeline item は表示専用とし、クリックによる diff 切り替えは後続タスクに分ける。
