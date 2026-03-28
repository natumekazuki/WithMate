# Worklog

- 2026-03-28: plan を開始。HomeApp の `Recent Sessions` と `Home right pane` を component に分離する。
- 2026-03-28: `src/home-components.tsx` に `HomeRecentSessionsPanel` と `HomeRightPane` を追加し、`src/HomeApp.tsx` の該当 JSX block を差し替えた。
- 2026-03-28: `npm run build` を実行し、component 分離後も build が通ることを確認した。
