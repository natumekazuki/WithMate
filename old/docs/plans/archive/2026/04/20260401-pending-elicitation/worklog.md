# Worklog

## 2026-04-01

- repo plan を作成
- Copilot SDK の `elicitation.requested` / `session.rpc.ui.elicitation` と既存 approval 実装の差分を確認
- `approvalRequest` と独立した `elicitationRequest` state、service、IPC、renderer form UI を実装
- `docs/design/provider-sdk-pending-items.md` を追加し、`docs/design/desktop-ui.md`、`docs/design/provider-adapter.md`、`docs/manual-test-checklist.md`、`docs/task-backlog.md` を同期
- 検証:
  - `npm run build`
  - `node --import tsx scripts/tests/copilot-adapter.test.ts`
  - `node --import tsx scripts/tests/session-runtime-service.test.ts`
  - `node --import tsx scripts/tests/session-elicitation-service.test.ts`
  - `node --import tsx scripts/tests/preload-api.test.ts`
  - `node --import tsx scripts/tests/main-ipc-registration.test.ts`
  - `node --import tsx scripts/tests/main-ipc-deps.test.ts`
- GitHub issue `#33` に完了コメントを追加
- コミット:
  - `2d65f89` `feat(session): support copilot elicitation`
