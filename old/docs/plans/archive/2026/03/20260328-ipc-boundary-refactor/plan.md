# 20260328 IPC Boundary Refactor

## 目的

- `preload.ts`、`withmate-window.ts`、`main-ipc-registration.ts` に集中している IPC 境界の責務を整理する
- renderer-main 間の API surface を domain ごとに見通しよくする
- `main.ts` の composition root を維持しつつ、IPC 登録と preload bridge の変更容易性を上げる

## スコープ

- `src/withmate-window.ts` の責務分割
- `src-electron/preload.ts` の API group 化
- `src-electron/main-ipc-registration.ts` の deps/register 整理
- 関連 unit test と `docs/design/refactor-roadmap.md` の更新

## 非スコープ

- renderer 側 UI の変更
- IPC channel 名の互換破壊を伴う rename
- 新機能追加

## 完了条件

1. `withmate-window` の channel / request-response type / API interface が分割されている
2. `preload.ts` が domain ごとの helper 経由で `withmateApi` を構成している
3. `main-ipc-registration.ts` の deps / register が domain ごとに読める形へ整理されている
4. 関連 test と `npm run build` が通る
