# Result

- 状態: 完了

## Summary

- Home の session list / monitor projection を `src/home-session-projection.ts` に分離した
- session search / monitor grouping / empty message の表示ルールを pure helper と test で固定した

## Verification

- `node --test --import tsx scripts/tests/home-session-projection.test.ts scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts`
- `npm run build`
