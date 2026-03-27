# Worklog

- 2026-03-28: plan を開始。Character Reflection 用の provider settings を app settings と Settings Window に追加する。
- 2026-03-28: `app_settings` に `character_reflection_provider_settings_json` を追加し、Settings Window に provider ごとの `Model / Reasoning Depth` を実装した。
- 2026-03-28: `node --test --import tsx scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/settings-ui.test.ts`、`node --import tsx scripts/tests/character-memory-storage.test.ts`、`node --import tsx scripts/tests/reset-app-database-targets.test.ts`、`npm run build` で確認した。
