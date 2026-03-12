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
- 永続化
- 実際のストリーミング

## Layout Direction

- `brand-card` は置かない
- `Home Window`
  - アプリアイコン + プロジェクト名のヘッダー
  - `Recent Sessions`
  - `New Session`
  - character 管理導線
- `Session Window`
  - 小さく圧縮した `Current Session Header`
  - `Work Chat`
  - 発話中心の `Character Stream`
  - `Diff Viewer`
- session 一覧では各項目にキャラクターアイコンを持たせつつ、`taskTitle / workspace / updatedAt / status` を優先して表示する
- キャラクターアイコンは `C:\Users\zgmfx\.codex\characters` 配下の `character.png` を前提にし、assistant message にも同じ avatar を出す
- Work Chat は作業用の整理された面として保つ
- assistant の返答カード内に `What Changed` `Run Summary` `Activity Notes` を表示し、そのターンで起きたことを読めるようにする
- assistant 側は `avatar + character name + tone + bubble` で、キャラがしゃべっている見え方を優先する
- `Turn Summary` はデフォルト折りたたみにして、必要なときだけ開けるようにする
- Character Stream は補助カラムではなく、アプリ固有価値を担う主画面として扱う
- 画面の主従は `Work Chat > Character Stream` ではなく、`Work Chat || Character Stream` の並列関係に寄せる
- Character Stream 側には現在のムード、反応密度、ピン留めキャラクター情報をまとめて表示する
- 見た目は VTuber キャラの温度感に寄せるが、作業面は coding agent としての読みやすさを優先する

## Current Mock Snapshot

- 現在の React 実装は `index.html` を `Home Window`、`session.html` を `Session Window` とする別 entry 構成
- Electron では実 `BrowserWindow` で起動し、Home / Session の分離も Main Process が担う
- browser-only preview 時だけ `localStorage` 共有の mock data を fallback として使う

### 現在の Entry Split

- `Home Window`
  - `Recent Sessions`
  - `Character Catalog`
  - `New Session` dialog 起動
  - `Session Window` を開く link / button
- `Session Window`
  - `Current Session Header`
  - `Work Chat`
  - `Character Stream`
  - `Diff Viewer`

## Target Window Split

### Home Window

- `Recent Sessions`
  - `Resume Picker` として表示
  - 各カードは `taskTitle / workspace / updatedAt / status / character / threadLabel` の順で判断材料を出す
- `New Session`
  - `workspace / character / approval` を dialog で確認して開始する
- `Character Catalog`
  - 利用可能キャラの確認と将来的な管理導線を置く

### Session Window

- `Current Session Header`
  - `workspace / provider / branch / run / approval` を細く確認するだけの帯
- `Work Chat`
  - assistant message ごとに `Turn Summary`
  - `What Changed / Run Summary / Activity Notes`
  - avatar + character name + bubble
- `Character Stream`
  - キャラの発話そのものを読む面
  - メタ情報カードは置かず、発話だけを流す
  - 面の役割が明白なら、見出しや名前ラベルも省略してよい
- `Diff Viewer`
  - アプリ内 overlay で split diff を開く

## Interaction Notes

- `Home Window` でセッションカードを押すと `session.html?sessionId=...` を開く
- Electron 実行時は `window.withmate.openSession(sessionId)` を優先し、browser preview 時だけ `window.open` へフォールバックする
- Electron 実行時の session 一覧と作成は Main Process store 経由で処理する
- `Recent Sessions` の役割は「最近の会話を見る」ことよりも、「どの workspace とタスクを再開するか選ぶ」ことに寄せる
- `New Session` dialog は `cd -> codex` 側、`Recent Sessions` は `codex resume` 側として責務を分ける
- `Session Window` は query string の `sessionId` を受け取り、対象 session 1 件に集中する
- assistant message にぶら下がる `Turn Summary` の内容は、その `Session Window` の turn にのみ紐づく
- `Open Diff` を押すと、別ウインドウではなく `Session Window` 内の split diff overlay が開く
- 入力欄の送信ボタンは、現在選択中 session の user message と stream を `localStorage` 上で更新する
- `New Session` は Home 側で session record を保存してから `Session Window` を開く
- `Browse` は Electron 実行時だけ OS の directory picker を開く
- `New Session` dialog の character choice も同じ avatar を使い、session 開始前からキャラ選択を視覚化する
- Character Stream は 2 から 3 種類のカードスタイルを混ぜて温度差を表現する
- Character Stream 側にも入力起点とは別の情報の流れを見せ、単なるサマリー欄に見えないようにする
- character PNG は Vite の `@fs` 経由で参照する

## TUI Comparison

- `Home Window`
  - `codex resume` の picker と新規起動前判断を担う
- `Recent Sessions`
  - `codex resume` の picker 相当
  - どの workspace と task を再開するかを決める
- `Session Window`
  - TUI に入った後の本体作業面
- `Current Session Header`
  - `cd` 後に、今どの workspace / run state / approval mode で動いているかを示す面
- `Work Chat`
  - 一覧で使う判断材料と、作業中に読む情報を混ぜない
- `Character Stream`
  - TUI にはない WithMate 固有の継続体験
  - 再開導線ではなく、作業継続中の存在感を担う

## Deliverables

- `src/HomeApp.tsx`
- `src/main.tsx`
- `src/session-main.tsx`
- `src/App.tsx`
- `src/mock-data.ts`
- `src/mock-ui.tsx`
- `src/styles.css`
- `index.html`
- `session.html`
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
- Session: `http://localhost:4173/session.html?sessionId=melt-main`

Electron で確認する場合:

```bash
npm run dev
# 別ターミナル
npm run electron:dev
```

確認済み:

- `npm run typecheck`
- `npm run build`
