# Worklog

## 2026-03-31

- `stale thread / session 起因エラーに対する最小安全版の自動 reset + 1 回 internal retry` を current scope として plan artifacts を作成した
- same-plan には `stale-thread classifier + internal retry` と `model / reasoningEffort` change 時の pre-send reset を含めると整理した
- DB 整合性は `threadId` reset 自体では壊れにくい一方、`threadId` クリアだけでは不十分で provider cache invalidate が必要という前提を明記した
- retry は `SessionRuntimeService` 内で同一 user turn に 1 回だけ行い、`partial result 実質なし` を必須条件にする方針を固定した
- Copilot の既存 stale connection retry は維持し、一般 transport error には広げないと決めた
- transport error 一般化、partial result 後 retry、public API retry は new-plan / follow-up に分けた
- session workspace 側の `plan.md` も同じ scope / decision に同期する
- `src-electron/session-runtime-service.ts` に narrow stale classifier、meaningful partial 判定、`threadId clear + provider cache invalidate` を伴う 1 回だけの internal retry を実装した
- `src/session-state.ts` と `src-electron/session-persistence-service.ts` で model / reasoningEffort change 時の pre-send reset を `threadId` クリア + provider cache invalidate の組で反映した
- `scripts/tests/session-runtime-service.test.ts`、`scripts/tests/session-persistence-service.test.ts`、`scripts/tests/session-state.test.ts` を更新し、retry 条件と pre-send reset 条件を回帰テストへ追加した
- `docs/design/provider-adapter.md`、`docs/design/session-run-lifecycle.md`、`docs/manual-test-checklist.md` を current behavior に合わせて更新した
