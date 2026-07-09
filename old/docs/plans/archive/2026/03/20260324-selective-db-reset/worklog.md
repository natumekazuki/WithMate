# Worklog

- 2026-03-24: plan 作成。現行 reset 導線と storage 構成を確認した。
- 2026-03-24: `resetAppDatabase` を選択式 API に更新。`all selected` では DB ファイル再生成、部分選択では storage ごとの reset を呼ぶようにした。
- 2026-03-24: Home Settings の Danger Zone に reset target checkbox 群を追加。`sessions` 選択時は `audit logs` を自動同伴させるようにした。
- 2026-03-24: `npm run build`、`node --import tsx scripts/tests/copilot-adapter.test.ts`、`node --import tsx scripts/tests/audit-log-storage.test.ts`、`node --import tsx scripts/tests/reset-app-database-targets.test.ts` を実行した。
- 2026-03-25: コミット `b892f01` `feat(runtime): 監査ログ構造化と DB 初期化を改善` を記録した。
