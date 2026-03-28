# Worklog

- 2026-03-29: task 開始。Character Editor 白画面と Settings 初期表示の不整合を修正する。
- 2026-03-29: `PersistentStoreLifecycleService` の初期化順を見直し、bundle 適用後に `syncSessionDependencies()` を呼ぶ形へ変更した。
- 2026-03-29: Home 右ペインの `nonRunningMonitorEntries` prop typo を修正し、renderer の `ReferenceError` を解消した。
- 2026-03-29: `cloneCharacterProfiles()` が `sessionCopy` を落としていたため、deep clone 対応を追加した。
- 2026-03-29: Settings Window の ready 判定を `settingsDraftLoaded` ベースへ変更し、draft hydrate 前に default が見える状態を防いだ。
- 2026-03-29: `node --test --import tsx scripts/tests/character-state.test.ts scripts/tests/home-settings-projection.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts scripts/tests/session-memory-support-service.test.ts` と `npm run build`、logging 付き `npm run electron:start` で確認した。
