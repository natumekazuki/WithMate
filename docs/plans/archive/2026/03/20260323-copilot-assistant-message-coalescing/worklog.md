# Worklog

## 2026-03-23

- plan を作成した
- `docs/Untitled-1.json` を確認し、Copilot の top-level `assistant.message` が 3 件返っているのに `assistantText = event.data.content` の上書きで最後の 1 件だけが残っていると切り分けた
- `src-electron/copilot-adapter.ts` に assistant message coalescing を入れ、top-level message を arrival 順に空行区切りで連結するようにした
- `assistant.message_delta` の draft と final `assistant.message` の二重化を避け、tool 配下 message は本文へ混ぜないようにした
- `scripts/tests/copilot-adapter.test.ts` に複数 message 連結、delta 重複防止、tool 配下無視の回帰テストを追加した
- docs-sync の判断で `docs/design/provider-adapter.md` と `docs/design/coding-agent-capability-matrix.md` を更新し、`docs/design/audit-log.md`、`.ai_context/`、`README.md` は更新不要とした
- `npm run typecheck`、`node --import tsx --test scripts/tests/copilot-adapter.test.ts`、`npm run build` を通した
