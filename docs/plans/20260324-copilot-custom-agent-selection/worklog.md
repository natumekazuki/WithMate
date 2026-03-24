# Worklog

## 2026-03-24

- 起票: Copilot custom agent selection 実装を開始
- `src/app-state.ts` と `src-electron/session-storage.ts` を拡張し、session metadata / 永続化に `customAgentName` を追加した
- `src-electron/custom-agent-discovery.ts` を追加し、workspace `.github/agents` と `~/.copilot/agents` の custom agent を探索して dedupe する実装を入れた
- `src-electron/main.ts`、`src-electron/preload.ts`、`src/withmate-window.ts` に custom agent 一覧取得 IPC を追加した
- `src/App.tsx` に Copilot 専用 `Agent` picker を追加し、選択変更時に session metadata を更新して thread を切り替えるようにした
- `src-electron/copilot-adapter.ts` で custom agent catalog と選択済み agent を `customAgents` / `agent` として session config へ反映するようにした
- `scripts/tests/custom-agent-discovery.test.ts` を追加し、workspace / global 探索と workspace 優先 dedupe を確認した
- `scripts/tests/session-storage.test.ts` に `customAgentName` の保存・読み戻し確認を追加し、`SessionStorage` の prepared statement 常駐を外して Windows cleanup lock を解消した
- `docs/design/provider-adapter.md`、`docs/design/coding-agent-capability-matrix.md`、`docs/manual-test-checklist.md` を更新した
- `npm run build`、`node --import tsx scripts/tests/custom-agent-discovery.test.ts`、`node --import tsx scripts/tests/session-storage.test.ts`、`node --import tsx scripts/tests/copilot-adapter.test.ts` で検証した
- `.ai_context/` はこのリポジトリに存在せず、`README.md` も今回の provider-specific UI/API slice では更新不要と判断した
