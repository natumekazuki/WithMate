# Result

## Status

- 状態: 完了
- 実装: 完了
- targeted validation: 完了
- final review: 完了
- archive: 完了

## Finished Outcome

- `SessionRuntimeService` に narrow stale classifier を追加し、`NotFound / expired / invalid-thread / model-incompatible` 系だけを `threadId clear + provider cache invalidate + 1 回 internal retry` の対象にした
- internal retry は `meaningful partial` が無い場合だけに制限し、`assistantText` / operations / artifact.changedFiles などが出た後は retry しないようにした
- `applySessionModelMetadataUpdate()` を model / reasoningEffort change 時の pre-send reset に変更し、`SessionPersistenceService.updateSession()` 側で provider cache invalidate を対にして保証した
- session / audit の public API retry は増やさず、同一 user turn の中で user message / assistant message / audit log record が二重化しない形に維持した
- docs と tests を current behavior に同期した

## Validation

- `git diff --check`: clean
- targeted tests: pass
- final review: 重大な指摘なし

## Docs Sync

- `docs/design/`: 更新済み
- `.ai_context/`: 更新不要
- `README.md`: 更新不要

## Archive

- archive 先: `docs/plans/archive/2026/03/20260331-session-thread-reset-retry/`
- 対応コミット:
  - `8ecbc492419377ab594ff6144bddca5717abe2fa` `fix(session-runtime): stale thread を自動リセットして再試行`

## Remaining

- なし

## Follow-Up

- stale 判定 message / error code の provider SDK 実測ベースでの追加調整
- transport error 一般化
- partial result 後 retry
- public API retry
