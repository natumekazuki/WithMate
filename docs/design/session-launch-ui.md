# Session Launch UI

- 作成日: 2026-03-11
- 対象: 新規セッション開始前のディレクトリ選択と起動導線

## Goal

WithMate における `New Session` 導線を、`Codex CLI` を新しく起動する前の判断と対応する形で設計する。
`resume picker` と競合させず、作業開始時に必要な最小判断だけを短く完了できる面にする。

## TUI Workflow Alignment

`Codex CLI` を新しく起動するとき、実際には次の判断をしている。

1. どの workspace へ入るか決める
2. その workspace で新しく始めるか、resume するか決める
3. 必要なら sandbox / approval / provider を確認する
4. session を開始してから最初の prompt を入れる

WithMate では、`Recent Sessions` が 2 の `resume` 側を担う。  
`New Session Launch` は 1 と 3 を短く完了させ、4 はメインチャットへ引き渡す UI として扱う。

## Responsibilities

### New Session Launch が担うもの

- 作業ディレクトリの選択
- 現在選択中の Character の確認
- Provider の確認
- Approval / sandbox など起動条件の確認
- 新規セッション開始

### 担わないもの

- 過去セッションの閲覧
- 詳細な session 管理
- Character Stream の内容確認
- 実行後の diff / activity 閲覧

## MVP Information Design

MVP では、次の 4 ブロックで十分。

1. `Workspace Picker`
- 現在選択中の directory
- `Browse` ボタン
- 最近使った workspace 候補があると良い

2. `Launch Profile`
- Provider (`Codex`)
- Character
- Approval mode
- 必要なら sandbox

3. `Launch Summary`
- `どこで / 誰で / どう起動するか` を 1 画面で確認

4. `Primary Action`
- `Start New Session`

## Layout Direction

レイアウトは wizard ではなく、1 画面の launch panel がよい。

### 推奨構成

- 上: `Workspace Picker`
- 中: `Launch Profile`
- 最下部: `Start New Session`

理由:

- 新規開始は頻繁に行うため、多段 wizard にすると遅い
- `resume picker` と同じ画面に置くなら、1 アクションで始められる方が自然
- TUI の `cd -> codex` に近いテンポを保てる

## UI States

### 1. 初期状態

- workspace 未選択
- `Start New Session` は無効
- 何を選べば開始できるかを短く示す

### 2. workspace 選択済み

- launch profile が有効
- 最近使った workspace なら軽い補足を出してよい

### 3. 開始直前

- summary に `workspace / provider / character / approval` を表示
- 誤起動しない程度の確認だけ残す

## Relation With Existing UI

- `Session Drawer`
  - 既存セッションへ戻る導線
- `New Session Launch`
  - 新しく始める導線

この2つを同じ `左面` に詰め込むより、`Drawer 上部に New Session ボタンを置いて dialog / popup を開く` 形が自然。

MVP では後者が妥当。

## Recommended Mock Direction

React モックでは次の形がよい。

- `Session Drawer` 上部に `New Session` ボタン
- ボタン押下で `Launch Dialog` を表示
- `Launch Panel` 内に
  - workspace path
  - browse ボタン
  - provider / character / approval
  - start action

## Current Mock Snapshot

- `Session Drawer` の header に `New Session` ボタンを追加済み
- `Launch Panel` は Drawer 内ではなく modal dialog として表示
- `Browse` はモック上では workspace 候補を順送りで切り替える
- workspace 候補は quick select chip でも選べる
- `Character` と `Approval` は chip で切り替える
- `Character` は portrait 付きカードで切り替える
- `Start New Session` を押すと、空の新規 session を先頭へ追加してそのまま選択状態へ移る
- 最初の依頼は Launch Dialog ではなくメインチャットから入力する

## Open Questions

- workspace picker を OS ダイアログ前提にするか、最近使った一覧からも選ばせるか
- sandbox を MVP で見せるか、approval のみ見せるか
- Character は固定選択にするか、launch 時に変えられるようにするか

## Next Step

- `Recent Sessions` との視線競合を見ながら、Drawer 内配置を調整する
- 将来は OS directory dialog と実 workspace 履歴へ接続する
