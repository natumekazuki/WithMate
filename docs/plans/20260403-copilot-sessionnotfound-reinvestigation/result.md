# Result

- status: in_progress

## Summary

- issue `#40` の原因は、Copilot adapter が未確定 step まで user-visible partial とみなして cached session recovery を止めていたことだった
- `toCommandOperations()` を completed / failed / canceled の command だけを残す形へ修正し、`tool.execution_start` や pending permission だけでは internal retry を止めないようにした
- `scripts/tests/copilot-adapter.test.ts` に回帰を追加し、build と関連 test で確認する

## Verification

- `node --import tsx scripts/tests/copilot-adapter.test.ts`
- `npm run build`

## Commits

- なし
