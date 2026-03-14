# Worklog

## Timeline

### 0001

- 日時: 2026-03-15
- チェックポイント: Audit Log 二重表示の原因確認
- 実施内容: `runSessionTurn()` が開始時と完了/失敗時に別々で `createAuditLog()` を呼んでいること、UI はそれを単純に 2 レコードとして表示していることを確認した
- 検証: `src-electron/main.ts`, `src-electron/audit-log-storage.ts`, `src/App.tsx` を確認
- メモ: 同じ prompt が `START` と `DONE` に重複して見えるのは仕様由来だった
- 関連コミット: なし

### 0002

- 日時: 2026-03-15
- チェックポイント: 1 turn = 1 レコード化
- 実施内容: 開始時に `running` レコードを作成し、完了/失敗時に同じ `id` を `updateAuditLog()` で更新する形へ変更した。UI の phase 表示も `RUNNING / DONE / FAIL` に揃えた
- 検証: 未実施
- メモ: 旧 `started` レコード互換のため、型と label 側では `started` も `RUNNING` として扱う
- 関連コミット: 未作成

## Open Items

- `npm run typecheck`
- `npm run build`
- コミット作成
