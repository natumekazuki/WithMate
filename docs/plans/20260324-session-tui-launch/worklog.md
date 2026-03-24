# Session TUI Launch Worklog

## 2026-03-24

- plan を作成した
- 既存の `src-electron/main.ts` / `src-electron/preload.ts` / `src/withmate-window.ts` / `src/App.tsx` を確認した
- 最小実装を「session の `workspacePath` で外部 terminal を開く機能」と定義した
- `src-electron/open-terminal.ts` を追加し、OS ごとの terminal 起動候補と Windows fallback を切り出した
- `src-electron/main.ts` / `src-electron/preload.ts` / `src/withmate-window.ts` に session 単位の terminal 起動 IPC を追加した
- `src/App.tsx` の `Top Bar` に `Terminal` ボタンを追加した
- `docs/design/desktop-ui.md` / `docs/design/session-window-layout-redesign.md` / `docs/design/session-window-chrome-reduction.md` / `docs/manual-test-checklist.md` を更新した
- `.ai_context/` はこの repo に存在しないため更新対象なし、`README.md` は今回の UI 追加では入口仕様が変わらないため更新不要と判断した
- `node --import tsx scripts/tests/open-terminal.test.ts` と `npm run build` を実行して通過した
