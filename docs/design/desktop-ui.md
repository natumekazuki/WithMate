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
- Settings overlay の操作余白を確保するため、既定サイズは少し大きめにする
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
  - `Coding Agent Providers` で provider ごとの enable / disable
  - `Coding Agent Credentials` で provider label を維持した `OpenAI API Key (Coding Agent)` 入力を表示
  - credential 補助文で `Character Stream 用ではない` ことを明示し、future note だけ最小限で置く
  - `Model Catalog` import / export
  - `Danger Zone` の `DB を初期化`
    - reset 対象: `sessions / audit logs / app settings / model catalog`
    - reset 非対象: `characters`
    - confirm 後に実行する
  - 初回リリース前は後方互換性を考慮せず、非互換変更時はここから回復する
  - 縦が小さいときも overlay 内スクロールで末尾まで操作できる

## Session Window

- Home と同じ dark base を使う
- キャラカラーは限定的に使い、過度に Session 全体へ広げない
- session title の rename / delete
- `Audit Log` overlay
- `Work Chat`
- 空 session では初期 assistant メッセージを置かない
- assistant / user message の markdown-like rich text 表示
- message list は条件付き follow mode で動かす
  - viewport bottom gap が 80px 以下のときは末尾追従を許可する
  - 80px を超えて上へ読んでいる間は位置を維持する
  - `selectedSession.id` 切替時は follow / unread state をリセットする
  - 追従停止中は `新着あり` / `読み返し中` の最小 banner を表示し、`末尾へ移動` で復帰できる
- pending 中の live activity / streaming response
- pending bubble の `live run step` は進捗 UI として表示し、`status / type` は人間向けラベルへ変換する
- `live run step` は `failed / canceled / in_progress` を先頭、`completed` を後段に並べ、`pending` や未知 status は safe degradation としてさらに後段へ送る。同一 bucket 内では到着順を維持する
- `in_progress` は最も強く、`failed / canceled` は alert 系で明確化する。`completed` は全体のノイズを抑えつつも、`command_execution` の command 文字列は安全確認のため読める濃さを維持する
- `assistantText` は pending bubble の会話本文として step list と分離して表示し、`agent_message` を live step row へ戻さない
- `assistantText` 未着でも pending bubble の step list を主役にし、`in_progress` step がある時だけ実行中 indicator を出して「今動いている」ことが分かるようにする。visible step が `completed / failed / canceled` のみなら非実行中を断定しない
- `command_execution` step は command 文字列を常時表示し、通常 paragraph ではなく shell command と即判別できる専用の monospace block で表示する
- `file_change` step は summary が複数行かつ `kind: path` 系の読み取り可能な形式なら、path を scan しやすい line item list で表示する。1 行 summary や未知フォーマットは raw summary fallback を維持する
- `details` は stdout / stderr や raw todo など step ごとの二次情報だけを折りたたみ表示し、`usage` は live run footer の集約表示だけを出す
- `liveRun.errorMessage` は step list と分離した alert block として扱う
- 実行中は `Send` の代わりに `Cancel` を表示
- assistant message ごとの `Turn Summary`
  - `Changed Files`
  - `Run Checks`
  - turn 内の `agent_message / command_execution / file_change / reasoning` を arrival 順に並べる operation timeline
- composer 上の添付 toolbar (`File / Folder / Image`)
- composer の attachment chip
- textarea 内の `@path` 参照
- `@path` 入力中の workspace file path 候補表示
- picker で選んだ file / folder / image も textarea に `@path` を挿入する
- 添付 picker は初回だけ workspace を開き、以後は最後に選んだディレクトリを開く
- composer 下の `Approval / Model / Depth`
- session title は character `main`
- assistant / pending bubble は `sub` ベースの薄い accent を持つ
- `composer settings` の背景は `sub` ベースの薄い accent を持つ
- `Send / Cancel` は character `main`
- `Details` 展開後の artifact block 背景は `main / sub` の薄い accent を持つ
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
- Session から開いた Diff は character theme snapshot を引き継ぎ、`titlebar / subbar / pane header` にだけ薄い accent を持つ
- `Before / After` 見出しは差分面から独立した label chip として表示し、背景色に埋もれないコントラストを維持する

## Interaction Notes

- Home から Session / Character Editor を開く
- Session の作成・更新・削除は Main Process 経由で永続化する
- Session の実行中イベントは Main Process から live state として IPC 中継する
- Session 実行の監査ログは SQLite に保存し、Session Window から閲覧する
- chat message は限定的な rich text renderer で整形表示する
- Settings overlay の `System Prompt Prefix` は SQLite に保存し、次回 turn から prompt composition へ反映する
- Settings overlay の `DB を初期化` 成功時は Home が reset 後 `appSettings` / `modelCatalog` / `sessions` へ同期し、settings draft の dirty を解消する
- character は `userData/characters/` を正本とする
- `userData` は `<appData>/WithMate/` に固定する
- Session は character の `main / sub` theme color snapshot を保持し、現在は header title、assistant / pending bubble、composer settings、`Send / Cancel`、artifact block、Session から開く Diff の `titlebar / subbar / pane header` の限定的な accent に使う
- session は SQLite を正本とする
- model catalog は DB の active revision を読む
- message list follow mode は assistantText streaming / pending 更新 / live run step 更新に反応し、表示追従と読み返し位置の維持を両立する

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
