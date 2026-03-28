# 20260328 Provider Boundary Refactor Worklog

- 2026-03-28: task 開始。`provider-runtime.ts`、`codex-adapter.ts`、`copilot-adapter.ts`、`memory-orchestration-service.ts` の責務棚卸しから着手。
- 2026-03-28: `ProviderCodingAdapter` / `ProviderBackgroundAdapter` を追加して、quota refresh・thread invalidation と Session Memory extraction・Character Reflection の呼び出し境界を分離。
- 2026-03-28: `MainProviderFacade`、`MainObservabilityFacade`、`MemoryOrchestrationService`、`provider-support`、関連 test を plane 分離へ追従。
