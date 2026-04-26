# Companion provider workspace 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。直近コミットは `af718a8`。
- provider 実行で `workspacePath` を参照している箇所を確認した。
- `RunSessionTurnInput` に `executionWorkspacePath` を追加し、未指定時は通常 Session の `workspacePath` へ fallback する helper を追加した。
- Codex / Copilot adapter の working directory、snapshot root、additional directory 正規化、path summary の基準を実行用 workspace path に対応させた。
- `docs-sync`: repo-sync-required。provider 実行境界の現行仕様が変わるため `docs/design/companion-mode.md` を更新した。`.ai_context/` は存在しないため更新なし。README は人間向け入口や公開導線の変更ではないため更新なし。
- 検証:
  - `npx tsc -p tsconfig.electron.json --noEmit`
  - `npx tsx --test scripts/tests/codex-adapter.test.ts scripts/tests/copilot-adapter.test.ts`
  - `npm test`
  - `npm run build`

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| provider 実行 workspace 切り替え | `ae0f563` | provider runtime に実行用 workspace path を渡せるようにする |
