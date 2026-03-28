# Worklog

- 2026-03-28: plan を開始。`App.tsx` の right pane / telemetry / background activity の派生状態を view model に分離する。
- 2026-03-28: `src/session-ui-projection.ts` を追加し、LatestCommand / quota / active tab の表示ルールを pure helper に切り出した。
- 2026-03-28: `Context` telemetry の summary / value 整形も `src/session-ui-projection.ts` に寄せた。
- 2026-03-28: `scripts/tests/session-ui-projection.test.ts` を追加し、command view / quota summary / auto tab / badge tone を固定した。
- 2026-03-28: `node --test --import tsx scripts/tests/session-ui-projection.test.ts` と `npm run build` を実行し、通過を確認した。
