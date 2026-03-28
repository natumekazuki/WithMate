# 20260329 Provider Coding Runtime Cleanup

## 目的

- `SessionRuntimeService` を `coding plane` 専用依存に寄せる
- `getProviderAdapter` のような曖昧な入口を減らし、runtime 側から background plane を見えなくする
- `main.ts` と `MainProviderFacade` の provider access を current 実装に合わせて整理する

## スコープ

- `src-electron/session-runtime-service.ts`
- `src-electron/main-provider-facade.ts`
- `src-electron/main.ts`
- 関連 test

## 非スコープ

- adapter 実装の挙動変更
- provider settings / prompt の仕様変更

## 完了条件

1. `SessionRuntimeService` が `ProviderCodingAdapter` のみへ依存している
2. `main.ts` と `MainProviderFacade` に不要な `getProviderAdapter` wrapper が残っていない
3. 関連 test と build が通る
