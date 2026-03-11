# UI React Mock

- 作成日: 2026-03-11
- 対象: メイン画面の React モック

## Goal

静的モックで固めた `Sidebar + Work Chat + Character Stream` 構成を、クリックと状態切り替えが見える React モックとして再構成する。
ベース体験は `Codex CLI` 相当の coding agent UI とし、その上に VTuber キャラクター前提の存在感を重ねる。

## Scope

- React + Vite による単画面モック
- セッション選択時の表示切り替え
- Character Stream のダミー更新表現
- assistant message 内に表示する `Turn Summary` のダミー表示
- `Open Diff` で開くアプリ内 split Diff Viewer のダミー表示
- 入力欄や送信ボタンの見た目と軽いインタラクション

## Out Of Scope

- Electron 統合
- Codex SDK 接続
- 永続化
- 実際のストリーミング

## Layout Direction

- `brand-card` は置かない
- 左上はアプリアイコン + プロジェクト名の小さなヘッダーにする
- 左カラムは `Navigation` ではなく、開閉できる `Session Drawer` として扱う
- セッション一覧では各項目にキャラクターアイコンを持たせつつ、`taskTitle / workspace / updatedAt / status` を優先して表示する
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

- `Session Drawer`
  - `Resume Picker` として表示
  - 各カードは `taskTitle / workspace / updatedAt / status / character / threadLabel` の順で判断材料を出す
  - header に `New Session` ボタンを置き、workspace / character / approval は別 dialog で確認して開始する
- `Current Session Header`
  - `workspacePath / provider / branch / run / approval` を確認できる構成
- `Work Chat`
  - assistant message ごとに `Turn Summary` をぶら下げる
  - `What Changed / Run Summary / Activity Notes` を折りたたみで見る
  - assistant 側は常時 avatar を表示し、ユーザー側は簡潔な bubble に留める
- `Character Stream`
  - `On-Air Stream` として再構成
  - ピン留めキャラ、現在の stream mode、軽い独り言の流れを分けて表示
- `Diff Viewer`
  - アプリ内 overlay で split diff を開く

## Interaction Notes

- Drawer の開閉ボタンで左カラムを畳める
- セッションカードを押すと右側のヘッダー、チャット、独り言内容が切り替わる
- Drawer の役割は「最近の会話を見る」ことよりも、「どの workspace とタスクを再開するか選ぶ」ことに寄せる
- Drawer の `New Session` dialog は `cd -> codex` 側、下部の `Recent Sessions` は `codex resume` 側として責務を分ける
- Drawer は `PowerShell -> cd -> codex resume` の手前でしている判断を置き換える面として扱う
- セッション切り替えに応じて、assistant message にぶら下がる `Turn Summary` の内容も切り替わる
- `Open Diff` を押すと、別ウインドウではなくアプリ内の split diff overlay が開く
- 入力欄の送信ボタンは押下演出のみ行い、ダミーのユーザー入力を末尾へ追加する
- `New Session` は空の session を開き、最初の依頼はメインチャットから送る
- `New Session` dialog の character choice も同じ avatar を使い、session 開始前からキャラ選択を視覚化する
- Character Stream は 2 から 3 種類のカードスタイルを混ぜて温度差を表現する
- Character Stream 側にも入力起点とは別の情報の流れを見せ、単なるサマリー欄に見えないようにする

## TUI Comparison

- `Session Drawer`
  - `codex resume` の picker 相当
  - どの workspace と task を再開するかを決める
- `Current Session Header`
  - `cd` 後に、今どの workspace / run state / approval mode で動いているかを示す面
- `Work Chat`
  - TUI に入った後の本体作業面
  - 一覧で使う判断材料と、作業中に読む情報を混ぜない
- `Character Stream`
  - TUI にはない WithMate 固有の継続体験
  - 再開導線ではなく、作業継続中の存在感を担う

## Deliverables

- `src/main.tsx`
- `src/App.tsx`
- `src/styles.css`
- `index.html`
- `vite.config.ts`

## Runbook

```bash
npm install
npm run dev
```

確認済み:

- `npm run typecheck`
- `npm run build`
