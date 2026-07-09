# Worklog

- 2026-03-28: plan を開始。`App.tsx` の `Diff modal` と `Audit Log modal` を component に分離する。
- 2026-03-28: `src/session-components.tsx` を追加し、`SessionDiffModal` と `SessionAuditLogModal` を切り出した。
- 2026-03-28: `src/App.tsx` の末尾 modal JSX block を component 呼び出しへ差し替えた。
- 2026-03-28: `npm run build` を実行し、component 分離後も build が通ることを確認した。
- 2026-03-28: `20af25e refactor(renderer): split home and session components`
