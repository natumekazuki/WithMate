# Result

## Status

- 状態: implemented

## Current Output

- `SessionRuntimeService` に narrow stale classifier を追加し、`NotFound / expired / invalid-thread / model-incompatible` 系だけを `threadId clear + provider cache invalidate + 1 回 internal retry` の対象にした
- internal retry は `meaningful partial` が無い場合だけに制限し、`assistantText` / operations / artifact.changedFiles などが出た後は retry しないようにした
- `applySessionModelMetadataUpdate()` を model / reasoningEffort change 時の pre-send reset に変更し、`SessionPersistenceService.updateSession()` 側で provider cache invalidate を対にして保証した
- session / audit の public API retry は増やさず、同一 user turn の中で user message / assistant message / audit log record が二重化しない形に維持した
- docs と tests を current behavior に同期した

## Remaining

- stale 判定 message / error code を provider SDK 実測でさらに絞り込みたくなった場合は follow-up で追加調整する
- manual test で provider 実機の stale thread / session 再現ケースを確認する

## Follow-Up

- transport error 一般化
- partial result 後 retry
- public API retry
