# Worklog

- 2026-03-28: plan を開始。settings / catalog の参照・正規化経路を整理する。
- 2026-03-28: 棚卸しを実施。`normalizeAppSettings()` は `src/app-state.ts`、永続化は `src-electron/app-settings-storage.ts`、renderer の draft 組み立ては `src/HomeApp.tsx`、catalog 参照は `src-electron/main.ts` と `src/HomeApp.tsx` に散っていることを確認した。
- 2026-03-28: `src-electron/settings-catalog-service.ts` を追加。`app settings` 更新と `model catalog` import / rollback / broadcast を service に集約した。
- 2026-03-28: `src/home-settings-view-model.ts` を追加。provider row の resolved selection と normalized provider settings 再構成を helper に分離した。
- 2026-03-28: `scripts/tests/settings-catalog-service.test.ts` と `scripts/tests/home-settings-view-model.test.ts` を追加し、settings / catalog 境界の主要経路を固定した。
- 2026-03-28: `node --test --import tsx scripts/tests/settings-catalog-service.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts` と `npm run build` を実行し、通過を確認した。
- 2026-03-28: コミット `0cf1148` `refactor(settings): extract catalog and draft helpers`
  - `SettingsCatalogService` を追加
  - `home-settings-view-model` を追加
  - `HomeApp` の settings 組み立てを整理
