# 20260329 Renderer IPC Wrapper Cleanup

## 目的

- renderer に残っている薄い `withmate` wrapper の重複を整理する
- `getWithMateApi()` の repeated guard を共通 helper に寄せる
- renderer / IPC boundary の current 形を過剰 abstraction なしで整える

## スコープ

- `src/renderer-withmate-api.ts`
- `src/HomeApp.tsx`
- `src/CharacterEditorApp.tsx`
- 必要なら `src/App.tsx` の簡単な置換

## 非スコープ

- IPC channel 仕様変更
- preload/main の API 再設計

## 完了条件

1. renderer 側の薄い `getWithMateApi` guard が減っている
2. helper が最小で読みやすい形に整理されている
3. build と関連 test が通る
