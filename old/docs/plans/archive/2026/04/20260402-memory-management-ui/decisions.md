# 20260402-memory-management-ui Decisions

## Decision 1: 管理 UI の配置

- status: 採用
- decision: Memory 管理 UI は Settings Window に追加する
- rationale:
  - 新規 window を増やさず既存の管理系 UI に統合できる
  - 現 task の scope を一覧・閲覧・削除に絞りやすい
  - 既存の app settings / danger zone と同じ運用導線に置ける

## Decision 2: renderer 取得方式

- status: 採用
- decision: renderer は Memory 全体の snapshot を 1 回で取得する
- rationale:
  - drilldown API を増やさず実装を閉じられる
  - Session / Project / Character を同一セクションで描画しやすい
  - delete 後は再取得で整合を保てる
