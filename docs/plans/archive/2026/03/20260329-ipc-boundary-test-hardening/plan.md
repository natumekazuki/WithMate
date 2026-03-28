# 20260329 IPC Boundary Test Hardening

## 目的

- IPC boundary refactor 後の `preload-api` と `main-ipc-registration` の回帰を domain ごとに固定する
- renderer/main 間の公開 API 面で、壊れやすい登録漏れや channel 名ズレを早めに検知できるようにする

## スコープ

- `src-electron/preload-api.ts`
- `src-electron/main-ipc-registration.ts`
- `src/withmate-window-api.ts`
- 関連 test

## 非スコープ

- IPC channel の仕様変更
- renderer 実装の変更

## 完了条件

1. preload / registration の domain grouping に対する test が増えている
2. 主要 API 面の regression を unit test で検知できる
3. build と関連 test が通る
