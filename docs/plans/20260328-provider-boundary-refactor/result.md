# 20260328 Provider Boundary Refactor Result

## 状態

- completed

## 概要

- `provider-runtime.ts` に `ProviderCodingAdapter` と `ProviderBackgroundAdapter` を追加し、`ProviderTurnAdapter` を両者の合成型に整理した
- `MainProviderFacade`、`MainObservabilityFacade`、`MemoryOrchestrationService` の依存を plane ごとに分離した
- quota refresh / thread invalidation は coding plane、Session Memory extraction / Character Reflection は background plane として扱う形に揃えた

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/main-observability-facade.test.ts scripts/tests/provider-support.test.ts scripts/tests/memory-orchestration-service.test.ts`
