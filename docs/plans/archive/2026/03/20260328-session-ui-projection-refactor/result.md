# Result

- 状態: 完了

## Summary

- `src/App.tsx` の right pane / provider telemetry の派生表示ルールを `src/session-ui-projection.ts` へ分離した
- `LatestCommand / MemoryGeneration / Monologue` の tab 表示、Copilot quota summary、自動切り替えを pure helper で扱う形にした
- `Context` telemetry の summary / value 整形も helper へ寄せた

## Verification

- `node --test --import tsx scripts/tests/session-ui-projection.test.ts`
- `npm run build`
