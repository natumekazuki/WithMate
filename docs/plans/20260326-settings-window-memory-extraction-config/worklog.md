# Worklog

- 2026-03-26: plan 作成。Settings overlay の項目増加に合わせて、独立 `Settings Window` 化と Memory Extraction 設定追加を同時に進める。
- 2026-03-26: `AppSettings` に `memoryExtractionProviderSettings` を追加し、provider ごとの `model / reasoning depth / outputTokens threshold` を保存できるようにした。
- 2026-03-26: `HomeApp` の Settings を overlay から `mode=settings` の別 window へ切り出し、Home の `Settings` button は window 起動導線だけを持つ構成へ変更した。
- 2026-03-26: `docs/design/settings-ui.md` と `docs/design/desktop-ui.md` を `Settings Window` 前提へ更新し、manual test と storage 設計も同期した。
- 2026-03-26: `npm run build` と `node --test --import tsx scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/settings-ui.test.ts` を通した。
