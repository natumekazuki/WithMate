# Result

## status

- 完了

## summary

- 独り言の `context-growth` trigger 条件を app-wide settings 化した
- 設定可能項目は `Cooldown Seconds` / `Min Char Delta` / `Min Message Delta`
- `session-start` の重複抑止は現行仕様のまま維持した

## commits

- `1739365` `feat(settings): add monologue trigger controls`

## 検証

- `npm run build`
- `node --import tsx scripts/tests/provider-settings-state.test.ts`
- `node --import tsx scripts/tests/character-reflection.test.ts`
- `node --import tsx scripts/tests/home-settings-draft.test.ts`
- `node --import tsx scripts/tests/home-settings-view-model.test.ts`
- `node --import tsx scripts/tests/settings-ui.test.ts`
- `node --import tsx scripts/tests/app-settings-storage.test.ts`
- `node --import tsx scripts/tests/memory-orchestration-service.test.ts`
- `node --import tsx scripts/tests/settings-catalog-service.test.ts`
