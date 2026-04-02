# worklog

## 2026-04-02

- plan 作成
- review `#3` `#4` `#10` の現状コードを確認開始
- `src/session-composer-feedback.ts` を追加し、sendability 導出と blocked feedback 強制表示、send button title 導出を pure helper へ切り出した
- `src/App.tsx` と `src/session-components.tsx` を更新し、blank draft の blocked shortcut 時に inline feedback を出しつつ、retry conflict / follow banner / composer feedback の live 通知を外した
- `src/error-boundary.tsx` を追加し、`src/main.tsx` `src/session-main.tsx` `src/character-main.tsx` `src/diff-main.tsx` に window-level fallback を接続した
- `SessionPaneErrorBoundary` に `右ペインを再描画` と `Window を再読み込み` を追加した
- `scripts/tests/session-composer-feedback.test.ts` を追加し、`npm run build`、`node --import tsx scripts/tests/session-composer-feedback.test.ts`、`node --import tsx scripts/tests/a11y.test.ts` を通した
- `docs/design/desktop-ui.md`、`docs/manual-test-checklist.md`、`docs/task-backlog.md` を current 実装へ同期した
