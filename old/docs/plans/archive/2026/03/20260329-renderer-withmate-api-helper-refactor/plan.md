# 20260329 Renderer WithMate API Helper Refactor

## 目的

- renderer からの `window.withmate` 直参照を減らす
- desktop runtime 判定と API 取得を共通 helper に寄せる
- `HomeApp`、`App`、`CharacterEditorApp`、`DiffApp` の guard を読みやすくする

## スコープ

- `src/renderer-withmate-api.ts`
- `src/HomeApp.tsx`
- `src/App.tsx`
- `src/CharacterEditorApp.tsx`
- `src/DiffApp.tsx`
- 関連 test

## 非スコープ

- IPC API 仕様変更
- renderer の UI 仕様変更

## 完了条件

1. `window.withmate` 直参照が共通 helper 経由に整理されている
2. desktop runtime 判定が helper に寄っている
3. build と関連 test が通る
