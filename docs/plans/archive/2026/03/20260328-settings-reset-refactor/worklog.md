# Worklog

- 2026-03-28: plan を開始。settings / catalog 系の reset / export 経路を service に寄せる。
- 2026-03-28: `SettingsCatalogService` に `exportModelCatalogDocument()` と `resetAppDatabase()` を追加した。
- 2026-03-28: `main.ts` の reset / export IPC を service 呼び出しへ切り替えた。
- 2026-03-28: `scripts/tests/settings-catalog-service.test.ts` に export / partial reset のテストを追加した。
- 2026-03-28: `node --test --import tsx scripts/tests/settings-catalog-service.test.ts scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/reset-app-database-targets.test.ts` と `npm run build` を実行し、通過を確認した。
- 2026-03-28: `13377e0` `refactor(settings): move reset and export flows into service`
  - `SettingsCatalogService` に reset / export orchestration を集約した。
