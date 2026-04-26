# Companion Merge Runs 実装 Decisions

## 2026-04-26

- 初期実装の `companion_merge_runs` は terminal 操作の completed 履歴だけを保存する。
- 保存対象は operation、selected paths、changed files、sibling warnings、created_at とする。
- Home 履歴カードは現行の `companion_sessions` summary 表示を維持し、表示元の切り替えは後続タスクに分ける。
