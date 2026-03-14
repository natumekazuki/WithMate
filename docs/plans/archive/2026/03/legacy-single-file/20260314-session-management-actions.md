# Goal
Session の削除機能とタイトル変更機能を追加し、Home / Session Window / SQLite 永続化の挙動を揃える。

## Task List
- [x] Session の削除ポリシーを決めて design doc に反映する
- [x] Session title 編集 UI を `Session Window` に追加する
- [x] Session 削除 UI を `Session Window` に追加する
- [x] Main Process / preload / session storage に deleteSession API を追加する
- [x] 実行中 session の削除禁止または確認制御を実装する
- [x] docs を更新する
- [x] `npm run typecheck` `npm run build` `npm run build:electron` で確認する

## Affected Files
- src/HomeApp.tsx
- src/App.tsx
- src/app-state.ts
- src/ui-utils.tsx
- src/withmate-window.ts
- src/renderer-env.d.ts
- src-electron/main.ts
- src-electron/preload.ts
- src-electron/session-storage.ts
- docs/design/window-architecture.md
- docs/design/electron-session-store.md
- docs/design/ui-react-mock.md
- docs/design/session-run-lifecycle.md
- docs/plans/20260314-session-management-actions.md

## Risks
- 実行中 session を削除できると state 整合が壊れる
- Session title の編集タイミング次第で Home 一覧との反映差が出る
- 削除導線を雑に置くと誤操作しやすい
- Session Window から削除した直後の close 遷移を崩す可能性がある

## Design Check
- 既存 Design Doc の更新が必要。新規 ADR は不要。

## Notes / Logs
- 2026-03-14: Session title は `Session Window` header で rename できるようにし、保存は `updateSession()` へ統一した。
- 2026-03-14: Session 削除は `Session Window` からのみ行う形に変更し、実行中 session は UI と Main Process の両方で拒否するようにした。
- 2026-03-14: `deleteSession()` を SQLite-backed session store と preload / IPC に追加した。
- 2026-03-14: `npm run typecheck` `npm run build` `npm run build:electron` を通した。

