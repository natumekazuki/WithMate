# 20260312-session-store-ipc

## Goal

Renderer が直接 `localStorage` を読む mock 依存をやめて、
Electron Main Process が `session metadata` の source of truth を持つ形へ移行する。
あわせて `New Session` に必要な directory picker を preload / IPC 境界へ追加し、
次の Codex Adapter 接続へ進める足場を作る。

## Design Check

- [x] `docs/design/electron-session-store.md` を新規作成する
- [x] [session-persistence.md](../design/session-persistence.md) の `Session Metadata` 保存責務と整合を取る
- [x] [electron-window-runtime.md](../design/electron-window-runtime.md) の preload API 設計を拡張する

## Task List

- [x] session store の責務と IPC 境界を設計 doc にまとめる
- [x] Main Process に mock session store を追加する
- [x] preload API に `listSessions` `createSession` `subscribeSessions` `pickDirectory` を追加する
- [x] Home Renderer から `localStorage` 依存を外して Main Process store へ切り替える
- [x] Session Renderer から `localStorage` 依存を外して session 取得 API へ切り替える
- [x] `New Session` の `Browse` を Electron directory picker に切り替える
- [x] browser-only fallback をどう残すか整理し、必要なら mock fallback を限定的に維持する
- [x] `npm run typecheck` と `npm run build` で検証する

## Affected Files

- `docs/design/session-persistence.md`
- `docs/design/electron-window-runtime.md`
- `docs/design/electron-session-store.md`
- `docs/plans/20260312-session-store-ipc.md`
- `src/HomeApp.tsx`
- `src/App.tsx`
- `src/mock-data.ts`
- `src/withmate-window.ts`
- `src/renderer-env.d.ts`
- `src-electron/main.ts`
- `src-electron/preload.ts`

## Risks

- IPC を event push にしすぎると mock 段階で過剰実装になる
- Session Renderer の取得 API を雑に切ると、後で Codex event store と競合する
- directory picker と session create を同時に変えるので、Launch Dialog の挙動が崩れやすい
- browser preview 互換を完全維持しようとすると二重実装になる

## Notes / Logs

- 現状の session data は `src/mock-data.ts` + `localStorage` に閉じている
- `session metadata` だけを Main Process へ寄せて、message / stream の本実装は次段階へ持ち越す想定
- browser-only preview は開発補助として残す可能性があるが、Electron 実行系を優先する
- 実装では message / stream も mock `Session` ごと Main Process store に載せている
- browser preview では fallback として `localStorage` を維持している
- `npm run typecheck` と `npm run build` は通過済み
