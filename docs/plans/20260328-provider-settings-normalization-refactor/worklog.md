# Worklog

- 2026-03-28: plan を開始。provider settings の正規化経路を統一する first slice に着手。
- 2026-03-28: `HomeApp.tsx` の settings draft を単一 `AppSettings` state に統一した。
- 2026-03-28: `home-settings-draft` に AppSettings 単位の update wrapper を追加した。
- 2026-03-28: `home-settings-view-model` に save 用の persisted settings 組み立て helper を追加した。
- 2026-03-28: `node --test --import tsx scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/settings-catalog-service.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts` と `npm run build` を実行し、通過を確認した。
- 2026-03-28: `d672b34` `refactor(settings): unify provider settings draft flow`
  - `HomeApp` の settings draft と save payload 組み立てを 1 つの流れに統一した。
