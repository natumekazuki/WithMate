# Result

- status: completed
- summary:
  - Settings を `Home Window` の overlay から独立 `Settings Window` へ切り出した
  - `AppSettings` に `memoryExtractionProviderSettings` を追加し、provider ごとの `model / reasoning depth / outputTokens threshold` を保存できるようにした
  - `Memory Extraction` UI は provider ごとの select / numeric input で扱い、save 時に model catalog と矛盾しない canonical shape へ正規化する
- verification:
  - `npm run build`
  - `node --test --import tsx scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/settings-ui.test.ts`
- commits:
  - `135ee51` `feat(settings): Settings Window と memory extraction 設定を追加`
