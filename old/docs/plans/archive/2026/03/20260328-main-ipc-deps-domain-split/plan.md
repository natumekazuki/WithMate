# 20260328 Main IPC Deps Domain Split

## 目的

- `main-ipc-deps.ts` と `main-bootstrap-deps.ts` に残っている巨大な引数束ねを domain 単位に整理する
- IPC registration 用 dependency の読み順を `window / catalog / settings / session / character` で固定する

## スコープ

- `src-electron/main-ipc-deps.ts`
- `src-electron/main-bootstrap-deps.ts`
- 関連 test
- `docs/design/refactor-roadmap.md`

## 非スコープ

- IPC channel 名の変更
- renderer 側 API surface の変更

## 完了条件

1. `createMainIpcRegistrationDeps()` の入力が domain ごとの object に整理されている
2. `createMainBootstrapDeps()` 側も同じ grouping を使っている
3. 関連 test と build が通る
