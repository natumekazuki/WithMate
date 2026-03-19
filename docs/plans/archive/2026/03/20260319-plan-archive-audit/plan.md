# Plan

## Goal

- 未アーカイブの plan を精査し、完了済みを archive へ移動する
- 記録不足の plan は archive 前に `worklog.md` / `result.md` を補完する
- 未完了 plan について、次の作業候補を整理する

## Scope

- `docs/plans/` 直下の未アーカイブ plan
- 各 plan の `plan.md` / `worklog.md` / `result.md`
- 必要最小限の記録補完と archive 移動

## Task List

- [ ] 未アーカイブ plan 一覧を確認する
- [ ] 完了 / 未完了を判定する
- [ ] archive 前に不足記録を補完する
- [ ] 完了済み plan を `docs/plans/archive/2026/03/` へ移動する
- [ ] 未完了 plan の次アクションを整理する

## Affected Files

- `docs/plans/20260315-audit-log-collapsible/*`
- `docs/plans/20260315-session-at-path-search/*`
- `docs/plans/20260315-session-cancel/*`
- `docs/plans/20260317-repo-audit-and-stabilization/*`
- `docs/plans/20260319-plan-archive-audit/*`

## Risks

- 記録不足のまま archive すると、後から rollback 基点や完了根拠を追えなくなる
- 未完了 plan を誤って archive すると、継続作業の文脈を失う

## Design Doc Check

- 状態: 対象外
- メモ: 今回は plan 管理文書のみを扱う
