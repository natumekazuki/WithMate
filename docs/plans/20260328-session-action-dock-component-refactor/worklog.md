# Worklog

- 2026-03-28: plan を開始。`App.tsx` の `retry banner` と compact row を component に分離する。
- 2026-03-28: `src/session-components.tsx` に `SessionRetryBanner` と `SessionActionDockCompactRow` を追加した。
- 2026-03-28: `src/App.tsx` の `retry banner` と compact row を component 呼び出しへ差し替えた。
- 2026-03-28: `src/session-components.tsx` に `SessionComposerExpanded` を追加し、expanded composer 本体も component に分離した。
- 2026-03-28: `npm run build` を実行し、component 分離後も build が通ることを確認した。
