# Companion Diff Snapshot 永続化 Decisions

## 2026-04-26

- diff snapshot は `ChangedFile[]` 相当を JSON として `companion_merge_runs.diff_snapshot_json` に保存する。
- terminal Review は latest merge run の diff snapshot を優先し、snapshot がない既存履歴では changed file summary + empty diff rows に fallback する。
- timeline item ごとの diff 切り替えは今回入れない。
