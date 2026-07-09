# Session Persistence Implementation Plan

## Goal
- Electron 再起動後もセッション一覧と session state が残るようにする。
- Main Process の in-memory session store を、SQLite-backed store へ置き換える。
- Renderer / IPC 境界は維持したまま、`listSessions` `getSession` `createSession` `updateSession` `runSessionTurn` の保存先だけ差し替える。

## Task List
- [x] `docs/design/electron-session-store.md` を更新し、in-memory から SQLite-backed store への移行方針を明記する。
- [x] `docs/design/session-persistence.md` を current implementation に合わせて更新する。
- [x] SQLite 利用ライブラリと DB 配置方針を確定する。
- [x] Main Process に session storage 実装を追加し、起動時ロードと更新時保存を入れる。
- [x] `createSession` `updateSession` `runSessionTurn` の保存経路を新 store へ統一する。
- [x] 既存 session schema の後方互換を最低限入れる。
- [x] `typecheck` と `build` を通す。

## Affected Files
- `docs/plans/20260314-session-persistence-implementation.md`
- `docs/design/electron-session-store.md`
- `docs/design/session-persistence.md`
- `package.json`
- `src-electron/main.ts`
- 新規 session storage 実装ファイル（例: `src-electron/session-storage.ts`）
- 必要に応じて `src/app-state.ts`

## Risks
- 保存タイミングを雑にすると、turn 実行中の state と保存内容がずれる。
- schema 変更時に既存データを読めなくすると、手元検証環境が壊れる。
- SQLite ライブラリの選定を誤ると Electron ランタイムとの相性で詰まる。

## Design Check
- 既存 design doc の更新が必須。
- 特に `docs/design/electron-session-store.md` と `docs/design/session-persistence.md` を current implementation に合わせて更新する。

## Notes / Logs
- 2026-03-14: 現状の session store は `src-electron/main.ts` 内の `let sessions = cloneSessions(initialSessions)` で、再起動後に保持されない。
- 2026-03-14: `docs/design/electron-session-store.md` でも現状は in-memory と明記されている。
- 2026-03-14: ユーザー方針として、session persistence は最初から SQLite で実装する。
- 2026-03-14: `better-sqlite3` は Electron 41 で rebuild に失敗したため、SQLite driver は Node 標準の `node:sqlite` へ切り替えた。
- 2026-03-14: `src-electron/session-storage.ts` を追加し、`messages_json` / `stream_json` を含む `sessions` テーブル 1 枚で永続化する形にした。
- 2026-03-14: 一時 DB を使ったスモークテストで、別インスタンスから同じ session を復元できることを確認した。

