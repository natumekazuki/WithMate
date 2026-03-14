# Electron Runtime Fixes Plan

## Goal
- `electron:start` で `Home` と `Character Editor` が正しく描画されるようにする。
- Electron 実行時に `window.withmate` API を安定して利用できるようにする。
- `Browse` が workspace preset 切り替えではなく OS の directory picker を開く状態へ戻す。

## Task List
- [x] Electron `BrowserWindow` 設定を見直し、preload API が renderer に露出される状態へ揃える。
- [x] `loadFile(..., { search })` と fallback URL を `file://` 実行でも壊れない形に修正する。
- [x] 関連 docs / plan を更新し、`typecheck` と `build` を通す。

## Affected Files
- `docs/plans/20260314-electron-runtime-fixes.md`
- `src-electron/main.ts`
- `src/app-state.ts`
- `docs/design/electron-window-runtime.md`
- 必要に応じて `docs/design/ui-react-mock.md`

## Risks
- `sandbox` 設定の変更は将来のセキュリティ設計に影響する。
- `file://` と dev server の両方を満たす URL 組み立てを崩すと別 entry が再度白画面になる。

## Design Check
- これは既存 runtime 挙動の修正なので、新規設計ではなく既存 design doc の更新で対応する。

## Notes / Logs
- 2026-03-14: `electron:start` で `Character Editor` が白画面になる原因は、`loadFile(..., { search })` に `?` 付き文字列を渡していたことだった。
- 2026-03-14: browser fallback の URL が `/character.html` / `/session.html` になっており、`file://` 実行で `file:///character.html` を指していたため html 相対パスへ修正した。
- 2026-03-14: Electron 実行時に `window.withmate` が露出されない問題を避けるため、現段階では `sandbox: false` にして preload API の安定動作を優先する。

