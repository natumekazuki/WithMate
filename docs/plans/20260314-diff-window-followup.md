# Goal
GitHub Desktop ライクな Diff 体験に近づけるため、Session Window 内の split Diff Viewer に左右横スクロール同期を追加し、必要時に専用 Diff Window へポップアウト表示できるようにする。

## Task List
- [x] Diff Viewer のスクロール構造を見直し、左右 code cell の横スクロール同期を実装する
- [x] Main Process / preload / renderer に Diff Window 起動 API を追加する
- [x] Diff Window 用の React entry と UI を追加し、現在の split diff を専用表示できるようにする
- [x] `Open In Window` 導線を Session Window の Diff Viewer に追加する
- [x] design / mock docs を更新する
- [x] `npm run typecheck` `npm run build` `npm run build:electron` で確認する

## Affected Files
- src/App.tsx
- src/styles.css
- src/withmate-window.ts
- src/renderer-env.d.ts
- src-electron/main.ts
- src-electron/preload.ts
- src/DiffApp.tsx
- src/diff-main.tsx
- diff.html
- vite.config.ts
- docs/design/ui-react-mock.md
- docs/design/electron-window-runtime.md
- docs/design/window-architecture.md
- docs/plans/20260314-diff-window-followup.md

## Risks
- 別 entry 追加で Vite / Electron の読み込みパスを壊す可能性がある
- Diff データの受け渡し方法を雑にすると renderer reload 時の復元性が落ちる
- 横スクロール同期の実装次第でスクロールのガタつきが出る可能性がある

## Design Check
- 既存 Design Doc の更新で対応する。新規 ADR は不要。

## Notes / Logs
- 2026-03-14: Diff 表示は `src/DiffViewer.tsx` へ切り出して、overlay と `Diff Window` の両方から共通利用する形にした。
- 2026-03-14: `Diff Window` は一時 token ベースで payload を受け取り、Electron 実行時は Main Process の in-memory store、browser fallback 時は `localStorage` を使うようにした。
- 2026-03-14: `npm run typecheck` `npm run build` `npm run build:electron` を通した。
