# Worklog

## 2026-03-23

- plan を作成した
- Copilot の `rawItemsJson` は packet dump ではなく stable event trace として扱う方針にした
- `assistant.message_delta`、`assistant.reasoning_delta`、`pending_messages.modified`、`hook.*`、`ephemeral: true` を drop し、`tool.execution_*`、`assistant.message`、`assistant.usage` などだけを残すようにした
- `tool.execution_complete` は `detailedContent` や full diff を残さず、`toolCallId / toolName / success / content / errorMessage` だけに圧縮した
- `scripts/tests/copilot-adapter.test.ts` に filtered trace の回帰テストを追加した
- docs-sync の判断で `docs/design/audit-log.md`、`docs/design/provider-adapter.md`、`docs/design/coding-agent-capability-matrix.md` を更新し、`.ai_context/` と `README.md` は更新不要とした
- `npm run typecheck`、`node --import tsx --test scripts/tests/copilot-adapter.test.ts`、`npm run build` を通した
