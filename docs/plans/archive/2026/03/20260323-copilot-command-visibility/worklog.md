# Worklog

## 2026-03-23

- plan を作成した
- Copilot sample event を確認し、`report_intent` のような補助 tool は無視して `shell / powershell / bash / terminal` と mutating tool だけを `Latest Command` へ載せる方針にした
- `src-electron/copilot-adapter.ts` で Copilot tool 名を正規化し、`create / edit / replace / move / delete` も `command_execution` として live step / audit `operations` に載せるようにした
- `src/App.tsx` の risk label 判定に `create / edit / replace / write / rename / delete` を追加した
- `scripts/tests/copilot-adapter.test.ts` に summary 生成と visible tool 判定の回帰テストを追加した
- docs-sync の判断で `docs/design/provider-adapter.md` と `docs/design/coding-agent-capability-matrix.md` を更新し、`.ai_context/` と `README.md` は更新不要とした
- `npm run typecheck`、`node --import tsx --test scripts/tests/copilot-adapter.test.ts`、`npm run build` を通した
