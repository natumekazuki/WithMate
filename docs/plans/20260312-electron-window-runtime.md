# 20260312-electron-window-runtime

## Goal

React/Vite の separate entry mock を土台に、WithMate の `Home Window` / `Session Window` を
Electron の実 `BrowserWindow` で起動できる最小ランタイムを導入する。
Main Process で window lifecycle を管理し、今後の Codex Adapter 接続先になる実行基盤を作る。

## Design Check

- [x] `docs/design/electron-window-runtime.md` を新規作成する
- [x] 既存の `docs/design/window-architecture.md` と矛盾しないことを確認する
- [x] `docs/design/ui-react-mock.md` の out-of-scope 状態を更新する

## Task List

- [x] Electron 導入方針を設計 doc にまとめる
- [x] `electron` 依存と実行スクリプトを `package.json` に追加する
- [x] Main Process の entry (`src-electron/main.ts`) を追加する
- [x] Preload (`src-electron/preload.ts`) を追加し、最小限の window API を露出する
- [x] `Home Window` を生成する `createHomeWindow` を実装する
- [x] `Session Window` を生成・再利用する `openSessionWindow(sessionId)` を実装する
- [x] 開発時は Vite server、build 時は `dist/` を読む分岐を実装する
- [x] Home mock から Electron API 経由で Session Window を開けるようにする
- [x] `sessionId -> BrowserWindow` の対応表管理を Main Process に実装する
- [x] `npm run typecheck` と起動確認コマンドで最小動作を検証する

## Affected Files

- `package.json`
- `tsconfig.json`
- `vite.config.ts`
- `index.html`
- `session.html`
- `src/HomeApp.tsx`
- `src/mock-data.ts`
- `src/mock-ui.tsx`
- `src/styles.css`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `docs/design/window-architecture.md`
- `docs/design/ui-react-mock.md`
- `docs/design/electron-window-runtime.md`

## Risks

- Vite dev server と Electron の起動導線が不整合だと開発体験が崩れる
- preload 境界を曖昧にすると、後で IPC 設計をやり直すことになる
- いまの `window.open` ベース mock を急に消すと browser-only 確認がしづらくなる
- build 出力の entry path と Electron 読み込み path がずれると packaging 前に壊れる

## Notes / Logs

- 現状は Electron 本体が未導入で、React/Vite の multi-page mock のみ存在する
- 実装では browser-only preview を残しつつ、Electron 実行時だけ `window.open` を IPC 呼び出しへ差し替える想定
- `npm run build` と `npm run typecheck` は通過済み
- `electron:dev` は Vite dev server を別ターミナルで起動してから使う前提
- session data は引き続き mock の `localStorage` を使っており、Main Process store への移行は次段階
