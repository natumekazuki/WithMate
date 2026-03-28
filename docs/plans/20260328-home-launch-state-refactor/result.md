# Result

- 状態: 完了

## Summary

- `src/home-launch-state.ts` を追加し、Home の launch dialog state/reset と session input 組み立てを helper に分離した
- `src/HomeApp.tsx` は launch dialog の local state を単一 draft にまとめ、open/close/start のロジックを helper 経由で扱うようにした

## Verification

- `node --test --import tsx scripts/tests/home-launch-state.test.ts scripts/tests/home-launch-projection.test.ts scripts/tests/home-session-projection.test.ts`
- `npm run build`
