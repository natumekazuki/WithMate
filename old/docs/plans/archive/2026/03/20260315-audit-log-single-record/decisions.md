# Decisions

## Summary

- Audit Log は `START/DONE/FAIL` の別レコードではなく、1 turn を 1 レコードとして `running/completed/failed` に更新する

## Decision Log

### 0001

- 日時: 2026-03-15
- 論点: Audit Log を `START` と `DONE/FAIL` の別レコードで持つか、1 turn 1 レコードにするか
- 判断: 開始時に `running` を 1 レコード作成し、完了/失敗時は同じレコードを更新する
- 理由: 同じ prompt の重複レコードは閲覧時のノイズが大きく、ユーザーが見たいのは 1 turn 単位の状態だから
- 影響範囲: `src/app-state.ts`, `src-electron/audit-log-storage.ts`, `src-electron/main.ts`, `src/App.tsx`, `docs/design/audit-log.md`, `docs/manual-test-checklist.md`
