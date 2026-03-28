# Result

- 状態: 完了

## Summary

- `src/home-character-projection.ts` を追加し、Home の Characters 右ペインにある検索結果と empty state の派生状態を helper に分離した
- `src/home-launch-projection.ts` から main character search の責務を外し、launch dialog の projection を本来の責務に絞った
- `src/HomeApp.tsx` の Characters 条件分岐を helper 経由に揃えた

## Verification

- `node --test --import tsx scripts/tests/home-character-projection.test.ts scripts/tests/home-launch-state.test.ts scripts/tests/home-launch-projection.test.ts scripts/tests/home-session-projection.test.ts`
- `npm run build`
