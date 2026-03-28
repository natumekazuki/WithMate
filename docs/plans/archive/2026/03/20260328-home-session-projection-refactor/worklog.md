# Worklog

- 2026-03-28: plan を開始。Home の session list / monitor 派生状態を pure helper に分離する。
- 2026-03-28: `src/home-session-projection.ts` を追加し、session search / monitor grouping / empty message の表示ルールを helper に切り出した。
- 2026-03-28: `scripts/tests/home-session-projection.test.ts` を追加し、session state / monitor grouping / empty message を固定した。
- 2026-03-28: `node --test --import tsx scripts/tests/home-session-projection.test.ts scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts` と `npm run build` を実行し、通過を確認した。
