# Session Launch UI

- 作成日: 2026-03-11
- 対象: 新規セッション開始前のディレクトリ選択と起動導線

## Goal

WithMate における `New Session` 導線を、`Codex CLI` を新しく起動する前の判断と対応する形で設計する。
`resume picker` と競合させず、作業開始時に必要な最小判断だけを短く完了できる面にする。
配置先は `Session Window` ではなく `Home Window` とする。

## TUI Workflow Alignment

`Codex CLI` を新しく起動するとき、実際には次の判断をしている。

1. どの workspace へ入るか決める
2. その workspace で新しく始めるか、resume するか決める
3. 必要なら provider を確認する
4. session を開始してから最初の prompt を入れる

WithMate では、`Recent Sessions` が 2 の `resume` 側を担う。  
`New Session Launch` は 1 と 3 を短く完了させ、4 はメインチャットへ引き渡す UI として扱う。

## Responsibilities

### New Session Launch が担うもの

- 作業ディレクトリの選択
- session title の入力
- 現在選択中の Character、またはランダム選択の確認
- Provider の確認
- 新規セッション開始
- model / depth / approval / sandbox / custom agent は launch dialog には出さない。Main Process が選択中 provider の直近 Session 一件から解決し、Settings / model catalog の変更と直列化して永続化する。継承と失敗時の方針は ADR 007 を参照する

### 担わないもの

- 過去セッションの閲覧
- 詳細な session 管理
- Character Stream の内容確認
- 実行後の diff / activity 閲覧
- model / depth の細かい調整

## MVP Information Design

MVP では、次の 4 ブロックで十分。

1. `Session Title`
- 空文字初期値
- 必須入力

2. `Workspace Picker`
- 現在選択中の directory
- `Browse` ボタン

3. `Launch Profile`
- Provider
  - `Coding Agent Providers` で有効な provider だけを候補として出す
- Character
  - search input
    - `name / description`
    - 部分一致

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
- `Home Window` 上の `Recent Sessions` と並ぶ管理導線として扱うなら、1 アクションで始められる方が自然
- TUI の `cd -> codex` に近いテンポを保てる

## UI States

### 1. 初期状態

- title 未入力
- workspace 未選択
- `Start New Session` は無効
- 何を選べば開始できるかを短く示す

### 2. workspace 選択済み

- launch profile が有効

### 3. 開始直前

- `title / workspace / provider / character` を確認して開始する
- 誤起動しない程度の確認だけ残す

## Relation With Window Architecture

- `Home Window`
  - 既存セッションへ戻る導線と、新しく始める導線をまとめる管理面
- `Session Window`
  - launch 完了後に開く作業面
- `New Session Launch`
  - `Home Window` の dialog / popup として表示する

MVP では `Home Window` 上部の `New Session` ボタンから dialog を開く形が妥当。

## Recommended Mock Direction

React モックでは次の形がよい。

- `Home Window` 上部に `New Session` ボタン
- ボタン押下で `Launch Dialog` を表示
- `Launch Panel` 内に
  - workspace path
  - session title
  - browse ボタン
  - SessionFolder ボタン
  - provider / character
  - start action

## Current Snapshot

- 現在の Home UI では上部バーに `New Session` を置いている
- `Launch Panel` 自体は modal dialog で維持できる
- `Browse` は Electron 実行時に OS の directory picker を開く
- Agent Mode の `SessionFolder` は path を事前確定せず、WithMate 管理下の SessionFolder を workspace にする選択として扱う
- title は空文字で開き、入力必須
- provider は launch dialog 内で chip 選択し、enabled provider が 0 件なら start できない
- `Character` は card で切り替える
- `Character` は portrait 付きカードで切り替える
- Character一覧の先頭にランダム選択カードを置く。ランダム選択時は、通常Sessionの最終利用順を使い、最近使っていないactive Characterほど高い重みで抽選する
- Character利用履歴がない場合はactive Characterを均等に抽選し、active Characterが0件なら既存のneutral fallbackを使う
- Session履歴の読み込み中または取得失敗時はランダム選択で開始せず、取得成功した0件と区別する
- `Character` には検索入力があり、`name / description` の部分一致で絞り込める
- launch dialog 内の character card も Home と同じ theme rule を使う
  - background = character `main`
  - left accent bar = character `sub`
  - foreground = background から自動コントラスト決定
- model / depth / approval / sandbox / custom agent は launch dialog には出さず、Main Process が選択中 provider の直近 Session 一件から解決する。Home の履歴キャッシュは実行設定の正本にせず、選択から永続化までは Settings / model catalog の変更と直列化する。詳細は ADR 007 を参照する
- session 作成直後の UI 表示も `自動実行 / 安全寄り / プロバイダー判断` の provider-neutral wording に揃える
- `provider` は session 作成時に明示保存する
- `Start New Session` を押すと、入力した title を持つ新規 session record を作って `Session Window` を開く
- Main Process は directory / SessionFolder のどちらでも Session ID を発行し、ID 衝突時に既存 record を上書きしない
- `SessionFolder` 選択時は `session-files/{sessionId}` を新規 directory として作成してから、その path を `workspacePath` として session record を保存する
- 最初の依頼は Launch Dialog ではなく `Session Window` のメインチャットから入力する

## Future Direction

- SessionFolder の orphan cleanup が必要になった場合は、永続 Session から参照されない directory だけを対象にした maintenance として追加する

## Next Step

- `Home Window` 内で `Recent Sessions` と視線競合しない配置に調整する
