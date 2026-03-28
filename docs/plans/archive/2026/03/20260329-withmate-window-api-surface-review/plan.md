# 20260329 WithMate Window API Surface Review

## 目的

- renderer/main 境界の public surface として `withmate-window-api` が current 実装に対して適切か確認する
- 過剰な public API や責務の混在があれば最小限の分割・整理を行う
- 今後の IPC 境界保守で正本にすべき module を固める

## スコープ

- `src/withmate-window-api.ts`
- `src/withmate-window.ts`
- `src/withmate-window-types.ts`
- `src/renderer-withmate-api.ts`
- 参照している renderer / test

## 非スコープ

- IPC channel 仕様変更
- main/preload の大規模再設計

## 完了条件

1. `withmate-window-api` の current 位置づけが整理されている
2. 必要なら最小限の type/module 分割が完了している
3. build と関連 test が通る
