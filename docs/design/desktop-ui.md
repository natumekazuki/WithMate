# Desktop UI

- 作成日: 2026-03-14
- 対象: Electron 版 WithMate の現在 UI

## Goal

Electron デスクトップアプリとして、`Home Window` / `Session Window` / `Character Editor Window` / `Diff Window` の責務を整理し、現行 UI の入口を 1 枚で把握できるようにする。

## Manual Test Maintenance

- 現行 UI に対する実機確認項目の正本は `docs/manual-test-checklist.md` とする
- この文書に影響する UI 変更を入れた場合は、同じ論理変更単位で実機テスト項目表も更新する
- 運用方針の詳細は `docs/design/manual-test-checklist.md` を参照する

## Scope

- Home の session / character 管理 UI
- Session の coding agent 作業 UI
- Character Editor の編集 UI
- Diff Window の閲覧 UI
- Settings overlay と model catalog 操作
- Session の監査ログ閲覧 UI

## Runtime

- 対応 runtime は Electron のみ
- renderer は `window.withmate` を前提に動作する
- Vite dev server は Electron 開発時の配信面として使い、browser 単体での利用はサポートしない

## Home Window

- 黒基調の管理ハブとして表示する
- 右カラム上段の `Settings` rail
- `Recent Sessions`
  - section action として `New Session`
  - resume picker
  - session search input
    - `taskTitle / workspace`
    - 部分一致
  - `taskTitle / workspacePath / updatedAt`
  - card theme
    - background = character `main`
    - left accent bar = character `sub`
    - text color = background とのコントラストから自動決定
- `running / interrupted` session chip
- `Characters`
  - search input + `Add Character`
  - `avatar / name`
  - card 全体クリックで `Character Editor` を開く
  - card theme
    - background = character `main`
    - left accent bar = character `sub`
    - text color = background とのコントラストから自動決定
- `New Session` dialog
  - session title 入力
  - workspace picker
  - character 選択
  - approval mode は `on-request` 固定
- `Settings` overlay
  - system prompt prefix 編集
  - model catalog import / export

## Session Window

- Home と同じ dark base を使う
- session title の rename / delete
- `Audit Log` overlay
- `Work Chat`
- 空 session では初期 assistant メッセージを置かない
- assistant / user message の markdown-like rich text 表示
- pending 中の live activity / streaming response
- 実行中は `Send` の代わりに `Cancel` を表示
- assistant message ごとの `Turn Summary`
  - `Changed Files`
  - `Run Checks`
  - turn 内の `agent_message / command_execution / file_change / reasoning` を arrival 順に並べる operation timeline
- composer 上の添付 toolbar (`File / Folder / Image`)
- composer の attachment chip
- textarea 内の `@path` 参照
- 添付 picker は初回だけ workspace を開き、以後は最後に選んだディレクトリを開く
- composer 下の `Approval / Model / Depth`
- `Ctrl+Enter` / `Cmd+Enter` 送信
- `interrupted` 時の再送導線
- inline `Diff Viewer` overlay
- `Open In Window` による `Diff Window` popout

## Character Editor Window

- `Profile / character.md` の 2 モード切り替え
- Home と同じ dark base を使う
- 画面下部固定の action bar に `Save / Delete`
- `Name`
- `Icon`
- `Description`
- `Theme Colors`
  - `main`
  - `sub`
  - color picker + RGB 入力
- `character.md`
- create / update / delete
- 小さい window では縦積みと外側スクロールを優先し、内部スクロールの多重化を避ける

## Diff Window

- side-by-side split diff
- 縦スクロール同期
- 横スクロール同期
- 長い行は横スクロールで読む

## Interaction Notes

- Home から Session / Character Editor を開く
- Session の作成・更新・削除は Main Process 経由で永続化する
- Session の実行中イベントは Main Process から live state として IPC 中継する
- Session 実行の監査ログは SQLite に保存し、Session Window から閲覧する
- chat message は限定的な rich text renderer で整形表示する
- Settings overlay の `System Prompt Prefix` は SQLite に保存し、次回 turn から prompt composition へ反映する
- character は `userData/characters/` を正本とする
- `userData` は `<appData>/WithMate/` に固定する
- Session は character の `main / sub` theme color snapshot を保持するが、Session UI 自体は neutral tone を維持する
- session は SQLite を正本とする
- model catalog は DB の active revision を読む

## Deliverables

- `src/HomeApp.tsx`
- `src/App.tsx`
- `src/MessageRichText.tsx`
- `src/CharacterEditorApp.tsx`
- `src/DiffApp.tsx`
- `src/DiffViewer.tsx`
- `src/app-state.ts`
- `src/ui-utils.tsx`
- `docs/design/message-rich-text.md`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src-electron/composer-attachments.ts`
- `src-electron/session-storage.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/app-settings-storage.ts`
- `src-electron/character-storage.ts`
- `src-electron/model-catalog-storage.ts`
- `docs/manual-test-checklist.md`

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
