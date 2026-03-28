# Result

- 状態: 完了

## Summary

- provider settings の正規化経路を `HomeApp` と shared helper で統一する
- first slice では `HomeApp` の settings draft を単一 `AppSettings` state にまとめ、save payload も helper で組み立てる

## Verification

- `node --test --import tsx scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/settings-catalog-service.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts`
- `npm run build`

## Commits

- `d672b34` `refactor(settings): unify provider settings draft flow`
