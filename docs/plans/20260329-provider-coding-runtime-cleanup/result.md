# 20260329 Provider Coding Runtime Cleanup Result

## 状態

- completed

## 概要

- `SessionRuntimeService` を `ProviderCodingAdapter` 専用依存へ整理した
- `MainProviderFacade` と `main.ts` から曖昧な `getProviderAdapter` wrapper を除去した
- `provider-support` の helper を coding/background の公開入口に寄せた

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/session-runtime-service.test.ts scripts/tests/main-provider-facade.test.ts scripts/tests/provider-support.test.ts`
