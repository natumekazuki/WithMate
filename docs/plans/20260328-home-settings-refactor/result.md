# Result

- 状態: 完了

## Summary

- `src/home-settings-projection.ts` を追加し、Settings Window の loading/reset 派生状態を helper に分離した
- `src/home-settings-actions.ts` を追加し、Settings Window の import / export / save / reset の async action と feedback 文言を helper に分離した
- `src/HomeApp.tsx` は Settings の state 適用と描画に寄せた

## Verification

- `node --test --import tsx scripts/tests/home-settings-actions.test.ts scripts/tests/home-settings-projection.test.ts scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts`
- `npm run build`
