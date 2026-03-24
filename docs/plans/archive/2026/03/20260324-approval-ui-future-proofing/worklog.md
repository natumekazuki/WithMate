# Worklog

## 2026-03-24

- `docs/FailedLog.json` を確認し、Copilot の失敗が `permission.requested` 未検知ではなく `user へ承認要求を返す経路がないため deny` になっていることを確認した
- `src-electron/copilot-adapter.ts` を確認し、`permission.requested` / `permission.completed` event と `onPermissionRequest` handler がすでに接続点として存在することを確認した
- `node_modules/@github/copilot-sdk/dist/types.d.ts` を確認し、`PermissionHandler` が `Promise` を返せることを確認した
- `src-electron/codex-adapter.ts` と `node_modules/@openai/codex-sdk/dist/index.d.ts` を確認し、Codex 側は `approvalPolicy` を thread option に渡すだけで、Copilot 相当の app callback は current SDK surface にないことを確認した
- 方針として、Copilot は direct approval、Codex は policy-based retry を採用しつつ、UI contract は将来の Codex callback 追加に備えて provider-neutral に切る判断を記録した
- `src/app-state.ts` `src/withmate-window.ts` `src-electron/provider-runtime.ts` に approval request 用の shared type / IPC contract を追加した
- `src-electron/main.ts` に pending approval resolver と renderer 往復を実装し、live run state に `approvalRequest` を載せて配信するようにした
- `src-electron/copilot-adapter.ts` で `provider-controlled` の non-read-only permission request を `onApprovalRequest` 経由で待機し、user decision を `PermissionHandler` へ返すようにした
- `src/App.tsx` `src/styles.css` に approval card UI を追加し、pending assistant bubble 内で `今回だけ許可 / 拒否` を返せるようにした
- `docs/design/provider-adapter.md` `docs/design/coding-agent-capability-matrix.md` `docs/design/agent-event-ui.md` `docs/manual-test-checklist.md` を現行仕様へ同期した
- `npm run build` を実行し、renderer / electron build が通ることを確認した

## Next

- follow-up としては Codex 側 callback 追加時に同じ `approvalRequest` contract を再利用できるか確認する
- Copilot approval 実機 manual test を行い、deny / cancel / multi-step turn の挙動を観測する
