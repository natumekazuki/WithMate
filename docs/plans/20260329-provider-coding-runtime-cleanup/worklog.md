# 20260329 Provider Coding Runtime Cleanup Worklog

- 2026-03-29: task 開始。`SessionRuntimeService`、`MainProviderFacade`、`main.ts` の `getProviderAdapter` 依存を棚卸し。
- 2026-03-29: `SessionRuntimeService` を `ProviderCodingAdapter` 依存へ変更。
- 2026-03-29: `MainProviderFacade` と `main.ts` から `getProviderAdapter` wrapper を削除し、`provider-support` の公開 helper を coding/background 入口へ絞った。
