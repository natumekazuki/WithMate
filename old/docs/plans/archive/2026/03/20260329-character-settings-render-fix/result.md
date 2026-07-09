# Result

- status: completed

## 変更概要

- `PersistentStoreLifecycleService` の初期化責務を整理し、storage bundle 適用後に session 依存同期を行うよう修正した。
- Home 右ペインの prop typo を修正し、Home 表示時の renderer 例外を解消した。
- `cloneCharacterProfiles()` で `sessionCopy` を deep clone するようにし、Character Editor の白画面要因を解消した。
- Settings Window の ready 判定を `settingsDraftLoaded && modelCatalogLoaded` に変更し、設定 hydrate 前の default 表示を防いだ。
- 対応コミット: `2d19760 fix(renderer): recover character and settings screens`

## 検証

- `node --test --import tsx scripts/tests/character-state.test.ts scripts/tests/home-settings-projection.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts scripts/tests/session-memory-support-service.test.ts`
- `npm run build`
- `ELECTRON_ENABLE_LOGGING=1 ELECTRON_ENABLE_STACK_DUMPING=1 npm run electron:start`
