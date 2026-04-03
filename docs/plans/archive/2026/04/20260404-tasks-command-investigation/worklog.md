# Worklog

## 2026-04-04

- issue `#17` の本文を確認した
- capability doc / adapter 実装 / test の調査を開始した
- local package と official doc を確認し、Copilot SDK には `session.idle.backgroundTasks` / `system.notification` があり、Codex SDK には同等 surface が見えないことを確認した
- `LiveSessionRunState.backgroundTasks` を追加し、Copilot session cache に background task observer を付けた
- Session 右ペイン `Latest Command` 配下へ `Tasks` card を追加した
- `docs/design/provider-sdk-pending-items.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/provider-adapter.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `docs/task-backlog.md`
- `f56be64 feat(session): add copilot tasks pane`
- 検証:
  - `node --import tsx scripts/tests/copilot-adapter.test.ts`
  - `node --import tsx scripts/tests/session-runtime-service.test.ts`
  - `node --import tsx scripts/tests/session-observability-service.test.ts`
  - `npm run build`
