# Result

- 状態: 完了

## Summary

- `src/home-launch-projection.ts` を追加し、Home の launch dialog / character list projection を pure helper に分離した
- `src/HomeApp.tsx` は launch dialog の描画と event handler 中心に寄せ、provider / character / workspace / start 可否の派生状態を helper 経由で扱うようにした

## Verification

- `node --test --import tsx scripts/tests/home-launch-projection.test.ts scripts/tests/home-session-projection.test.ts`
- `npm run build`

## Commits

- `eefa486` `refactor(home): extract launch projection helpers`
