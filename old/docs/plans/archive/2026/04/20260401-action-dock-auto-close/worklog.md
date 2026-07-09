# Worklog

## 2026-04-01

- repo plan を作成した
- `AppSettings` と `app_settings` storage に `autoCollapseActionDockOnSend` を追加し、default true / normalize / 永続化を実装した
- Settings Window に `送信後に Action Dock を自動で閉じる` checkbox を追加した
- Session Window の send path で、通常送信が通った直後だけ `Action Dock` を compact へ戻すようにした
- `scripts/tests/provider-settings-state.test.ts`、`scripts/tests/home-settings-draft.test.ts`、`scripts/tests/home-settings-view-model.test.ts`、`scripts/tests/app-settings-storage.test.ts` を更新した
- `docs/design/desktop-ui.md`、`docs/manual-test-checklist.md`、`docs/task-backlog.md` を current 実装へ同期した
- GitHub issue `#30` に 2026-04-01 の対応コメントを追加した
- `node --import tsx scripts/tests/provider-settings-state.test.ts`、`scripts/tests/home-settings-draft.test.ts`、`scripts/tests/home-settings-view-model.test.ts`、`scripts/tests/app-settings-storage.test.ts` と `npm run build` の成功を確認した
- コミット `3d9a6b3` `feat(session): auto-close action dock after send` を作成し、実装・docs・tests・plan を保存した
