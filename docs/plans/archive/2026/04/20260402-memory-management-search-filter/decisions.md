# 20260402-memory-management-search-filter Decisions

## Decision 1: filter state の配置

- status: 採用
- decision: search / filter / sort の state は `SettingsMemoryManagementSection` 内の renderer local state で持つ
- rationale:
  - persistence や IPC を増やさず完結できる
  - `Settings Window` を閉じれば自然に reset される操作状態だから

## Decision 2: filter の粒度

- status: 採用
- decision: global search + domain filter を基本にし、domain ごとに最小限の追加 filter を置く
- rationale:
  - 一覧 delete 中の主要ニーズを満たしやすい
  - UI を複雑化させず current scope に収められる
