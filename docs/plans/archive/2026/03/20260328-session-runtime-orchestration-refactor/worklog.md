# Worklog

- 2026-03-28: plan を開始。`main.ts` から session runtime orchestration を service に分離する first slice を切る。
- 2026-03-28: `src-electron/session-runtime-service.ts` を追加。`runSessionTurn`、cancel、in-flight 管理、audit / live run / background task 起動を service へ移した。
- 2026-03-28: `scripts/tests/session-runtime-service.test.ts` を追加。成功、cancel、in-flight 可視化の 3 ケースを先に固定した。
- 2026-03-28: first slice の責務境界を見直し、`session 起動 / 再開` は window lifecycle との結合が強いため、次 slice の `session open/resume bridge` へ分離する方針にした。
