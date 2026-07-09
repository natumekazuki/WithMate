# Result

- 状態: 完了

## Summary

- `src/home-settings-draft.ts` を追加し、provider ごとの settings draft 更新ロジックを pure function に分離した
- `src/HomeApp.tsx` の provider settings handler を helper 呼び出しへ置き換えた

## Verification

- `node --test --import tsx scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/settings-catalog-service.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts`
- `npm run build`

## Notes

- renderer 側の settings state はまだ `HomeApp.tsx` に残るが、更新ロジック自体は helper に隔離できた
- 対応コミット: `0cf1148` `refactor(settings): extract catalog and draft helpers`
