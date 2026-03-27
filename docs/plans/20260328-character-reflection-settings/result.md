# Result

- 状態: 完了

## Summary

- Character Reflection の provider settings を追加した
- `app_settings` に provider ごとの `Character Reflection model / reasoning depth` を保存できるようにした
- Settings Window に `Character Reflection` セクションを追加した

## Verification

- `node --test --import tsx scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/settings-ui.test.ts`
- `node --import tsx scripts/tests/character-memory-storage.test.ts`
- `node --import tsx scripts/tests/reset-app-database-targets.test.ts`
- `npm run build`

## Notes

- 実装 slice
