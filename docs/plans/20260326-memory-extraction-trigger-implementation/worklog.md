# Worklog

- 2026-03-26: plan 作成。memory extraction trigger と SessionMemoryDelta の validate / merge 実装に着手する。
- 2026-03-26: `session-memory-extraction.ts` を追加し、trigger 判定、固定 prompt、JSON parse / normalize を切り出した。
- 2026-03-26: `CodexAdapter` と `CopilotAdapter` に hidden extraction session を追加し、provider ごとの `model / reasoning depth` で SessionMemoryDelta を取得できるようにした。
- 2026-03-26: `main.ts` で turn 完了後の threshold 判定と Session Window close 時の強制実行を接続した。
- 2026-03-26: `node --import tsx scripts/tests/session-memory-extraction.test.ts` と `npm run build` を通した。
- 2026-03-26: `docs/design/audit-log.md` と `docs/design/memory-architecture.md` に、memory extraction を `background-*` phase として監査に残す方針を追記した。
- 2026-03-26: `audit_logs` に `background-running / background-completed / background-failed / background-canceled` を追加し、memory extraction の create/update path を `main.ts` に接続した。
- 2026-03-26: `node --import tsx scripts/tests/session-memory-extraction.test.ts` と `node --import tsx scripts/tests/audit-log-storage.test.ts` を再実行し、background audit log の roundtrip を確認した。
