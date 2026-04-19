# UI React Mock

- 作成日: 2026-03-11
- 対象: React ベースの UI モック

## Goal

静的モックで固めた UI を、クリックと状態切り替えが見える React モックとして再構成する。
ベース体験は `Codex CLI` 相当の coding agent UI とし、その上に VTuber キャラクター前提の存在感を重ねる。
最終的な target architecture は `Home Window` と `Session Window` の分離である。

## Scope

- React + Vite による複数 entry の画面モック
- セッション選択時の表示切り替え
- Character Stream のダミー更新表現
- assistant message 内に表示する `Turn Summary` のダミー表示
- `Open Diff` で開くアプリ内 split Diff Viewer のダミー表示
- 入力欄や送信ボタンの見た目と軽いインタラクション

## Out Of Scope

- Electron の IPC / session store 本実装
- Codex SDK 接続
- session 永続化
- 実際のストリーミング

## Layout Direction

- `brand-card` は置かない
- `Home Window`
  - アプリアイコンと `Settings` / `Add Character` / `New Session` の上部バー
  - `Recent Sessions`
  - `Characters` list
  - character / session の empty state
  - `New Session` dialog
  - `Settings` overlay
- `Session Window`
  - 必須情報だけ残した最小構成
  - `Work Chat`
  - `Diff Viewer`
  - `Diff Window` への popout 導線
- session 一覧では各項目にキャラクターアイコンを持たせつつ、`taskTitle / workspace / updatedAt / status` を優先して表示する
- キャラクターアイコンは WithMate 管理の character storage 配下にある `character.png` を前提にし、assistant message にも同じ avatar を出す
- Work Chat は作業用の整理された面として保つ
- assistant の返答カード内に `What Changed` `Run Summary` `Activity Notes` を表示し、そのターンで起きたことを読めるようにする
- assistant 側は `avatar + bubble` を軸にして、キャラがしゃべっている見え方を優先する
- `Turn Summary` はデフォルト折りたたみにして、必要なときだけ開けるようにする
- 見た目は VTuber キャラの温度感に寄せるが、作業面は coding agent としての読みやすさを優先する

## Current Mock Snapshot

- 現在の React 実装は `index.html` を `Home Window`、`session.html` を `Session Window` とする別 entry 構成
- Electron では実 `BrowserWindow` で起動し、Home / Session の分離も Main Process が担う
- browser-only preview 時だけ `localStorage` 共有の mock data を fallback として使う
- character catalog は Electron 実行時に `userData/characters` を正本として読む

### 現在の Entry Split

- `Home Window`
  - `Recent Sessions`
  - `Characters` list
  - `Settings` overlay から model catalog import / export
  - `New Session` dialog 起動
  - `Character Editor Window` を開く button
  - `Session Window` を開く button
- `Session Window`
  - `Work Chat`
  - `Diff Viewer`
  - `Diff Window` への `Open In Window`
  - composer 下の `Model / Depth`
  - session title の rename
  - session 削除
  - `interrupted` 時の再送導線

## Target Window Split

### Home Window

- `Recent Sessions`
  - `Resume Picker` として表示する
  - 各カードは `taskTitle / workspace / updatedAt / status / taskSummary` に絞る
- `Characters`
  - `avatar / name / short description / Edit` の最小カードで表示する
  - 0 件なら `Add Character` だけ残した empty state を出す
- `New Session`
  - `Browse` で選んだ workspace path と `character / approval` を最小 dialog で確認して開始する
- `Settings`
  - Home 上の overlay として開く
  - model catalog import / export を置く
  - file picker と save dialog は Main Process 側で開く
- `Character Editor Window`
  - create / edit / delete を集中して扱う
  - metadata form と `character.md` editor を分離する
  - `Role` を `character.md` の正本として編集する
  - 右面は editor-like な markdown 面として広く確保する
  - icon は image picker から選ぶ

### Session Window

- `Work Chat`
  - assistant message ごとに `Turn Summary`
  - `What Changed / Run Summary / Activity Notes`
  - avatar + bubble
  - composer 下に `Model / Depth` controls を置く
- `Diff Viewer`
  - アプリ内 overlay で split diff を開く

## Interaction Notes

- `Home Window` でセッションカードを押すと `session.html?sessionId=...` を開く
- Electron 実行時は `window.withmate.openSession(sessionId)` を優先し、browser preview 時だけ `window.open` へフォールバックする
- browser fallback の `session.html` / `character.html` URL は `file://` 実行でも壊れないよう html 相対パスで組み立てる
- Electron 実行時の session 一覧と作成は Main Process store 経由で処理する
- `Recent Sessions` の役割は「最近の会話を見る」ことよりも、「どの workspace とタスクを再開するか選ぶ」ことに寄せる
- `New Session` dialog は `cd -> codex` 側、`Recent Sessions` は `codex resume` 側として責務を分ける
- `New Session` dialog の workspace は候補一覧を持たず、picker と選択済み path 表示だけに絞る
- `Session Window` は query string の `sessionId` を受け取り、対象 session 1 件に集中する
- `Session Window` 内のラベルは原則削り、操作や判断に必須なものだけ残す
- session title は `Session Window` の header で rename できる
- session 削除も `Session Window` の header から行う
- approval mode は `Session Window` のヘッダーから後で変更できる
- model は session が参照している catalog revision の select で変更できる
- depth は selected model の候補だけを chip で変更できる
- `New Session` dialog では model / depth を出さず、default 値で session を作る
- `interrupted` session は composer の上に最小の再送 banner を出し、直前 user message を同じ内容で送り直せる
- assistant message にぶら下がる `Turn Summary` の内容は、その `Session Window` の turn にのみ紐づく
- `Open Diff` を押すと、まず `Session Window` 内の split diff overlay が開く
- `Open Diff` は diff rows を持つ file だけに出し、`add / edit / delete` すべてで side-by-side の `Before / After` を見られる
- Diff Viewer は同一ウインドウ内 overlay を維持しつつ、左右ペインごとの横スクロール同期と縦スクロール同期を持つ
- overlay から `Open In Window` を押すと、専用 `Diff Window` へ同じ split diff を popout 表示する
- 入力欄の送信ボタンは、現在選択中 session の user message と stream を `localStorage` 上で更新する
- `New Session` は Home 側で session record を保存してから `Session Window` を開く
- `Browse` は Electron 実行時だけ OS の directory picker を開く
- `New Session` dialog の character choice も同じ avatar を使い、必要な選択だけ残す
- character 0 件なら `New Session` dialog は start を無効化し、`Add Character` 導線だけを出す
- character の作成 / 編集 / 削除は別 entry の `Character Editor Window` へ逃がす
- character PNG は Vite の `@fs` 経由で参照する

## TUI Comparison

- `Home Window`
  - `codex resume` の picker と新規起動前判断を担う
- `Recent Sessions`
  - `codex resume` の picker 相当
  - どの workspace と task を再開するかを決める
- `Session Window`
  - TUI に入った後の本体作業面
- `Session Window` はラベルを原則持たず、必要な操作だけ見せる
- `Work Chat`
  - 一覧で使う判断材料と、作業中に読む情報を混ぜない

## Deliverables

- `src/HomeApp.tsx`
- `src/main.tsx`
- `src/session-main.tsx`
- `src/character-main.tsx`
- `src/App.tsx`
- `src/DiffApp.tsx`
- `src/DiffViewer.tsx`
- `src/app-state.ts`
- `src/ui-utils.tsx`
- `src/styles.css`
- `index.html`
- `session.html`
- `character.html`
- `diff.html`
- `vite.config.ts`
- `src-electron/main.ts`
- `src-electron/preload.ts`

## Runbook

```bash
npm install
npm run dev
```

起動先:

- Home: `http://localhost:4173/`
- Session: `http://localhost:4173/session.html?sessionId=<sessionId>`

Electron で確認する場合:

```bash
npm run dev
# 別ターミナル
npm run electron:dev
```

確認済み:

- `npm run typecheck`
- `npm run build`

