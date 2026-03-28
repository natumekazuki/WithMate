# 20260328 Provider Boundary Refactor Worklog

- 2026-03-28: task 開始。`provider-runtime.ts`、`codex-adapter.ts`、`copilot-adapter.ts`、`memory-orchestration-service.ts` の責務棚卸しから着手。
- 2026-03-28: `ProviderCodingAdapter` / `ProviderBackgroundAdapter` を追加して、quota refresh・thread invalidation と Session Memory extraction・Character Reflection の呼び出し境界を分離。
- 2026-03-28: `MainProviderFacade`、`MainObservabilityFacade`、`MemoryOrchestrationService`、`provider-support`、関連 test を plane 分離へ追従。
- 2026-03-28: `c492a01` `refactor(provider): split coding and background planes`
  - provider runtime の interface を coding/background plane に分離
  - `MainProviderFacade` / `MainObservabilityFacade` / `MemoryOrchestrationService` を新境界へ追従
  - 関連 unit test と build を通過
