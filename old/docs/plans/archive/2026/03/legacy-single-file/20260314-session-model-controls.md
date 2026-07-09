# Goal
アプリ組み込みの model catalog と自由入力を使って、Session Window の composer 下で model / reasoning depth を選択できるようにし、その設定を session metadata と CodexAdapter 実行に反映する。

## Task List
- [x] model catalog と session metadata の設計を決めて design doc に反映する
- [x] `Session` 型と SQLite schema に `model` / `reasoningEffort` を追加する
- [x] `New Session` と `Session Window` に model / depth UI を追加する
- [x] model catalog に基づく depth 候補表示と fallback 解決ロジックを実装する
- [x] CodexAdapter に resolved model / reasoningEffort を渡す
- [x] docs を更新する
- [x] `npm run typecheck` `npm run build` `npm run build:electron` で確認する

## Affected Files
- src/app-state.ts
- src/ui-utils.tsx
- src/HomeApp.tsx
- src/App.tsx
- src/withmate-window.ts
- src-electron/preload.ts
- src-electron/main.ts
- src-electron/session-storage.ts
- src-electron/codex-adapter.ts
- docs/design/provider-adapter.md
- docs/design/session-launch-ui.md
- docs/design/electron-session-store.md
- docs/design/ui-react-mock.md
- docs/design/product-direction.md
- docs/plans/20260314-session-model-controls.md

## Risks
- model / reasoningEffort の fallback が見えにくいと、実際に何で走ったか分かりづらい
- SQLite schema 変更で既存 session の後方互換を壊す可能性がある
- モデル catalog を UI に埋め込みすぎると将来更新が重くなる

## Design Check
- 既存 Design Doc の更新が必要。新規 ADR は不要。

## Notes / Logs

- `New Session` dialog には model / depth を出さず、default 値で session を作る形に整理した
- `Session Window` の composer 下に datalist 付き model input と depth chip を置いた
- `better-sqlite3` ではなく `node:sqlite` 前提の既存 session store に column migration を追加した
- SQLite の保存復元は built output を使った簡易スモークで `model` / `reasoningEffort` が保持されることを確認した

