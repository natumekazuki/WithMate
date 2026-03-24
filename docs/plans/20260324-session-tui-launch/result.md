# Session TUI Launch Result

## Status

- 状態: completed

## Summary

- Session Window の `Top Bar` から、対象 session の `workspacePath` を作業ディレクトリにした外部 terminal を起動できるようにした
- 初回実装は埋め込み PTY ではなく外部 terminal 起動に限定し、Windows では `wt.exe -> pwsh.exe -> powershell.exe -> cmd.exe` の順で fallback する
- renderer は session ID だけを main process に渡し、実際の `workspacePath` 解決と terminal 起動は main 側で処理する
- `docs/design/` と実機チェック項目を現仕様へ同期した

## Updated Files

- `src-electron/open-terminal.ts`
- `scripts/tests/open-terminal.test.ts`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src/withmate-window.ts`
- `src/App.tsx`
- `docs/design/desktop-ui.md`
- `docs/design/session-window-layout-redesign.md`
- `docs/design/session-window-chrome-reduction.md`
- `docs/manual-test-checklist.md`

## Verification

- `node --import tsx scripts/tests/open-terminal.test.ts`
- `npm run build`
