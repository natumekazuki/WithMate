# Worklog

## 2026-03-23

- plan を作成した
- `docs/design/coding-agent-capability-matrix.md` を見て、次の capability を `changed files / diff` に決めた
- `Details` 欠落の直接原因が Copilot 側 `artifact` 未実装であることを再確認した
- Codex adapter の snapshot diff fallback と `runChecks` 組み立てを読み、Copilot では provider-native `file_change` ではなく snapshot 差分ベースで MVP を作る方針にした
- `src-electron/provider-artifact.ts` を追加し、snapshot diff から `changedFiles`、operations から `activitySummary / operationTimeline`、provider metadata と usage から `runChecks` を作る helper を切り出した
- `src-electron/copilot-adapter.ts` で before / after snapshot を取り、Copilot turn 完了時と partial result 時の両方で `artifact` を返すようにした
- `scripts/tests/provider-artifact.test.ts` を追加し、snapshot diff から最小 artifact が組み立つことを確認した
- docs-sync の判断で `docs/design/provider-adapter.md`、`docs/design/coding-agent-capability-matrix.md`、`docs/manual-test-checklist.md` を更新し、`docs/design/audit-log.md`、`.ai_context/`、`README.md` は更新不要とした
- `npm run typecheck`、`node --import tsx --test scripts/tests/copilot-adapter.test.ts scripts/tests/provider-artifact.test.ts`、`npm run build` を通した
