# Plan

- task: PR #82 review fixes を separate slices で進める
- date: 2026-04-23
- owner: Codex

## 目的

- PR review follow-up の 3 finding を separate slices で修正し、実装 / 検証 / レビューを 1 task として管理する
- stale pending 表示の解消、live-run → audit operations 変換ロジックの共通化、success 後の `activeRunningSession` 整合修正を完了できる状態にする

## スコープ

- `src/audit-log-refresh.ts`
- `src-electron/session-runtime-service.ts`
- `src/live-run-audit-operations.ts`
- `scripts/tests/audit-log-refresh.test.ts`
- `scripts/tests/session-runtime-service.test.ts`
- 上記に紐づく関連 tests

## Out Of Scope

- PR #82 review follow-up と無関係な runtime / renderer 変更
- 公開仕様、README、ユーザー導線の変更
- owner コメント『送信プロンプトも確定時点で記録したい』を独立 slice として追加実装すること

## Slice / Checkpoint

### Slice 1: stale pending 表示の解消

- finding: stale pending 表示が残るケースを解消する
- primary files:
  - `src/audit-log-refresh.ts`
  - `scripts/tests/audit-log-refresh.test.ts`
- checkpoint:
  - [x] stale pending 表示の原因を特定し、refresh 時の状態更新へ反映する
  - [x] 対象 test を更新し、pending 表示の取り残しが再現しないことを確認する

### Slice 2: live-run → audit operations 変換ロジックの共通化

- finding: live-run → audit operations 変換ロジックの重複を解消し、共通 helper 化を実施する
- primary files:
  - `src/live-run-audit-operations.ts`
  - `src/audit-log-refresh.ts`
  - `src-electron/session-runtime-service.ts`
  - 関連 tests
- checkpoint:
  - [x] renderer / electron 間で共有すべき変換ロジックを切り出す
  - [x] 既存の挙動を崩さずに共通化し、関連 test で回帰がないことを確認する

### Slice 3: success 後の `activeRunningSession` 整合修正

- finding: success 後に `activeRunningSession` が不整合になるケースを解消する
- primary files:
  - `src-electron/session-runtime-service.ts`
  - `scripts/tests/session-runtime-service.test.ts`
- checkpoint:
  - [x] success 遷移後の `activeRunningSession` 更新条件を整理する
  - [x] 対象 test を追加または更新し、success 後の整合が保たれることを確認する

## Affected Files

- `src/audit-log-refresh.ts`
- `src-electron/session-runtime-service.ts`
- `src/live-run-audit-operations.ts`
- `scripts/tests/audit-log-refresh.test.ts`
- `scripts/tests/session-runtime-service.test.ts`

## Validation Plan

- [x] `scripts/tests/audit-log-refresh.test.ts` を含む `npm test` を実行し、stale pending 表示解消を確認した
- [x] `scripts/tests/session-runtime-service.test.ts` を含む `npm test` を実行し、`activeRunningSession` 整合修正を確認した
- [x] `npm run build` を実行し、live-run → audit operations 共通化を含む変更後も build が通ることを確認した
- [x] separate slices で進めた変更を 1 task の plan / worklog / result に集約した

## Docs Sync

- 判定: `docs/design/` / `.ai_context/` / `README.md` は更新不要
- 理由:
  - 変更対象は internal runtime / renderer fix と test / refactor に留まるため
  - 公開仕様やユーザー導線を変更しないため

## Archive Check

- tier: repo
- 対象: docs/plans/archive/2026/04/20260423-pr82-review-fixes/
- archive 先: docs/plans/archive/2026/04/20260423-pr82-review-fixes/
- archive-ready: 完了
