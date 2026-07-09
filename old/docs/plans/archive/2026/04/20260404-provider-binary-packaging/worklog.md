# worklog

## 2026-04-04

- 初期化: provider binary packaging を `node_modules` 依存から切り離す方針で着手
- 実装: `src-electron/provider-binary-paths.ts` を追加し、`Codex` / `Copilot` の runtime path 解決を共通化
- 実装: `scripts/stage-provider-binaries.ts` と `package.json` の `extraResources` を追加し、`build/provider-binaries/` から `resources/provider-binaries/` へ配布する形へ変更
- 実装: native provider package を app bundle 側から除外し、`CodexAdapter` は `codexPathOverride`、`CopilotAdapter` は `cliPath` で staged binary を使うように変更
- 検証: `npm run build`、`node --import tsx scripts/tests/provider-binary-paths.test.ts`、`node --import tsx scripts/tests/copilot-adapter.test.ts`、`npm run dist:dir`
- コミット: `10f019b` `fix(distribution): provider binary の配布経路を分離する`
- 検証: `npm run dist:win` で `release/WithMate Setup 1.0.2.exe` を生成
