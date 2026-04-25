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
- アクティブな repo plan: `docs/plans/20260425-copilot-command-approval-error/plan.md`
- 対象範囲は `src-electron/copilot-adapter.ts` と `scripts/tests/copilot-adapter.test.ts`
- validation: `npm test` PASS / `npm run build` PASS
- quality review: no material findings
- docs sync: unnecessary
- archive: ready -> `docs/plans/archive/2026/04/20260425-copilot-command-approval-error/`
