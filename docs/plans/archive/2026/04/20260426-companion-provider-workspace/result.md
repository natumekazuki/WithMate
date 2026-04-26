# Companion provider workspace 実装 Result

- status: completed
- started: 2026-04-26
- completed: 2026-04-26

## 結果

- provider runtime に `executionWorkspacePath` を追加し、通常 Session の `workspacePath` とは別の実行用 workspace path を渡せるようにした。
- Codex adapter は working directory、additional directories、snapshot root、path summary の基準に実行用 workspace path を使う。
- Copilot adapter は workingDirectory、custom agent discovery、snapshot root、approval path、tool summary、artifact path の基準に実行用 workspace path を使う。
- `docs/design/companion-mode.md` に provider runtime の実行用 workspace path 境界を反映した。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit`
- `npx tsx --test scripts/tests/codex-adapter.test.ts scripts/tests/copilot-adapter.test.ts`
- `npm test`
- `npm run build`

## コミット

- `ae0f563` feat(companion): provider 実行 workspace を切り替え可能にする
