# Worklog

## 2026-03-24

- 起票: Copilot image を file attachment として吸収する変更を開始
- `src-electron/copilot-adapter.ts` の image reject を外し、`kind: "image"` も `type: "file"` へ変換するようにした
- `src/App.tsx` から Copilot 専用の `Image` disabled 判定を外し、共通 UI に戻した
- `scripts/tests/copilot-adapter.test.ts`、`docs/design/provider-adapter.md`、`docs/design/coding-agent-capability-matrix.md`、`docs/manual-test-checklist.md` を更新した
