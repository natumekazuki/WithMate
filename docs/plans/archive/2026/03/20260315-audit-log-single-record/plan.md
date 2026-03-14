# Plan

## Goal

- Audit Log を `1 turn = 1 レコード` 表示に切り替え、phase を `RUNNING / DONE / FAIL` として扱う

## Scope

- `src-electron/audit-log-storage.ts`
- `src-electron/main.ts`
- `src/App.tsx`
- `docs/design/audit-log.md`
- `docs/manual-test-checklist.md`

## Task List

- [x] 現状の `START / DONE / FAIL` 2重 insert 構造を確認する
- [x] `running` レコードを作成して完了/失敗時に更新する実装へ変更する
- [x] Audit Log UI の phase label を `RUNNING / DONE / FAIL` に揃える
- [ ] 検証してコミットする

## Affected Files

- `src/app-state.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/main.ts`
- `src/App.tsx`
- `docs/design/audit-log.md`
- `docs/manual-test-checklist.md`

## Risks

- 既存の旧 `started` レコードは DB に残る
- 新旧 phase 名の互換を一時的に持つ必要がある

## Design Doc Check

- 状態: 確認済み
- 対象候補: `docs/design/audit-log.md`, `docs/manual-test-checklist.md`
- メモ: Audit Log の記録単位が変わるので同期が必要
