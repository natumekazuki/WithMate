# Result

## Status

- 状態: 完了

## Current Output

- approval UI の follow-up task 用 plan を作成した
- Copilot は direct approval callback を使う方針、Codex は policy-based retry を使う方針を確定した
- 将来 Codex SDK に approval callback が追加されても renderer を崩さないよう、provider-neutral な approval UI contract を切る方針を確定した
- Copilot `provider-controlled` の approval request を Session UI の pending bubble 内で `今回だけ許可 / 拒否` できるようにした
- main process に pending approval resolver を実装し、renderer と Copilot `PermissionHandler` の往復を接続した
- design docs と manual test checklist を current 実装へ同期した

## Remaining

- Copilot approval の実機 manual test
- 将来 Codex 側に callback surface が来た場合の再利用確認

## Related Commits

- なし

## Related Docs

- `docs/design/provider-adapter.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/agent-event-ui.md`
- `docs/manual-test-checklist.md`
