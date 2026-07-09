# Active Plan

## Problem
- bundled `@github/copilot` runtime が legacy permission response kind を検証し続けるため、v2 approval kind をそのまま返すと `permission: approved` 後に `unexpected user permission response` が発生する。

## Approach
- `src-electron/copilot-adapter.ts` で内部 approval decision を legacy runtime kind (`approve-once` / `reject` / `user-not-available`) へ橋渡しする。
- live `permission.completed` status は legacy / v2 の approval-like kind をともに `in_progress` とみなす。
- `allow-all` / `safety` / `provider-controlled` と live status 判定の回帰テストで固定する。

## Todos
- [x] bundled runtime の permission response kind 制約を確認する
- [x] `src-electron/copilot-adapter.ts` に legacy kind bridge を実装する
- [x] approval mode 別の回帰テストと live status 判定テストを追加する
- [x] 検証結果を記録する

## Notes
- 対象 plan: `docs/plans/20260425-copilot-command-approval-error/plan.md`
- 対象範囲は `src-electron/copilot-adapter.ts` と `scripts/tests/copilot-adapter.test.ts`
- validation: `npm test` PASS / `npm run build` PASS
- quality review: no material findings
- docs sync: unnecessary
- implementation commit: 5e74333d8ff407b09fae5ff03b1661931af961ca fix(copilot-adapter): legacy approval 契約へ橋渡しして回帰を防ぐ
- archive commit: 02b44f29ed331924bb8a69ef1e32e85e314f9515 docs(plan): セッション計画をアーカイブへ移動
- rollback target: 本タスクの巻き戻し先は archive commit `02b44f29ed331924bb8a69ef1e32e85e314f9515`
- archive: archived -> `docs/plans/archive/2026/04/20260425-copilot-command-approval-error/`

## Archive Check
- tier: session
- 対象: `docs/plans/archive/2026/04/20260425-copilot-command-approval-error/`
- archive 先: `docs/plans/archive/2026/04/20260425-copilot-command-approval-error/`
- archive-ready: 完了
- archive 状態: archived
