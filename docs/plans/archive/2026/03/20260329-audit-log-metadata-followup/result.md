# Result

- 状態: 完了
- AuditLog に `durationMs`、main turn の `projectMemoryHits / attachmentCount`、background task の memory 件数 metadata を追加
- Audit Log overlay の details 初期状態をすべて collapsed に変更
- 検証:
  - `npm run build`
  - `node --test --import tsx scripts/tests/memory-orchestration-service.test.ts scripts/tests/copilot-adapter.test.ts scripts/tests/session-runtime-service.test.ts scripts/tests/session-memory-support-service.test.ts`
- 対応コミット:
  - `75a88d9` `feat(session): refine audit and monologue monitoring`
