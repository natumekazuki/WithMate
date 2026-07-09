# Result

- 状態: 完了

## Summary

- `SettingsCatalogService` に `model catalog export` と `DB 初期化` orchestration を追加した
- `main.ts` から settings / catalog 系の reset / export write path をさらに剥がした

## Commits

- `13377e0` `refactor(settings): move reset and export flows into service`

## Verification

- `node --test --import tsx scripts/tests/settings-catalog-service.test.ts scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/reset-app-database-targets.test.ts`
- `npm run build`

## Notes

- file dialog 自体は `main.ts` に残す
