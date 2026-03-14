# Desktop UI

- 作成日: 2026-03-14
- 対象: Electron 版 WithMate の現在 UI

## Goal

Electron デスクトップアプリとして、`Home Window` / `Session Window` / `Character Editor Window` / `Diff Window` の責務を整理し、現行 UI の入口を 1 枚で把握できるようにする。

## Scope

- Home の session / character 管理 UI
- Session の coding agent 作業 UI
- Character Editor の編集 UI
- Diff Window の閲覧 UI
- Settings overlay と model catalog 操作

## Runtime

- 対応 runtime は Electron のみ
- renderer は `window.withmate` を前提に動作する
- Vite dev server は Electron 開発時の配信面として使い、browser 単体での利用はサポートしない

## Home Window

- 上部バー
  - `Settings`
  - `Add Character`
  - `New Session`
- `Recent Sessions`
  - resume picker
  - `taskTitle / workspace / updatedAt / status / taskSummary`
- `running / interrupted` session chip
- `Characters`
  - `avatar / name / description / Edit`
- `New Session` dialog
  - workspace picker
  - character 選択
  - approval mode 選択
- `Settings` overlay
  - model catalog import / export

## Session Window

- session title の rename / delete
- approval mode 切り替え
- `Work Chat`
- assistant message ごとの `Turn Summary`
- composer 下の `Model / Depth`
- `Ctrl+Enter` / `Cmd+Enter` 送信
- `interrupted` 時の再送導線
- inline `Diff Viewer` overlay
- `Open In Window` による `Diff Window` popout

## Character Editor Window

- `Name`
- `Icon`
- `Description`
- `Role (character.md)`
- create / update / delete

## Diff Window

- side-by-side split diff
- 縦スクロール同期
- 横スクロール同期
- 長い行は横スクロールで読む

## Interaction Notes

- Home から Session / Character Editor を開く
- Session の作成・更新・削除は Main Process 経由で永続化する
- character は `userData/characters/` を正本とする
- session は SQLite を正本とする
- model catalog は DB の active revision を読む

## Deliverables

- `src/HomeApp.tsx`
- `src/App.tsx`
- `src/CharacterEditorApp.tsx`
- `src/DiffApp.tsx`
- `src/DiffViewer.tsx`
- `src/app-state.ts`
- `src/ui-utils.tsx`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src-electron/session-storage.ts`
- `src-electron/character-storage.ts`
- `src-electron/model-catalog-storage.ts`

## Runbook

```bash
npm install
npm run dev
# 別ターミナル
npm run electron:dev
```

ビルド済み確認:

```bash
npm run build
npm run electron:start
```
