# Session Launch UI

- 作成日: 2026-03-11
- 対象: 新規セッション開始前のディレクトリ選択と起動導線

## Goal

WithMate における`NewSession`導線を、`Codex CLI`を新しく起動する前の判断と対応する形で設計する。
`RestoreSessions`と競合させず、作業開始時に必要な最小判断だけを短く完了できる面にする。
配置先は`SessionWindow`ではなく`HomeWindow`とする。

## TUI Workflow Alignment

`Codex CLI` を新しく起動するとき、実際には次の判断をしている。

1. どの workspace へ入るか決める
2. その workspace で新しく始めるか、resume するか決める
3. 必要なら provider を確認する
4. session を開始してから最初の prompt を入れる

WithMateでは、`RecentSessions`と`RestoreSessions`がstep 2の`resume`側を担う。
`NewSessionLaunch`は 1 と 3 を短く完了させ、4 はメインチャットへ引き渡すUIとして扱う。

## Responsibilities

### NewSessionLaunch が担うもの

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

1. `SessionTitle`
- 空文字初期値
- 必須入力

2. `WorkspacePicker`
- 現在選択中の directory
- `Browse` ボタン

3. `LaunchProfile`
- Provider
  - `CodingAgentProviders` で有効な provider だけを候補として出す
- Character
  - Random または active Character の selector

4. `PrimaryAction`
- `StartNewSession`

## Layout Direction

レイアウトは wizard ではなく、1 画面の launch panel がよい。

### 推奨構成

- 上: `WorkspacePicker`
- 中: `LaunchProfile`
- 最下部: `StartNewSession`

理由:

- 新規開始は頻繁に行うため、多段 wizard にすると遅い
- `HomeWindow`上の`RecentSessions`と並ぶ管理導線として扱うなら、1 actionで始められる方が自然
- TUI の `cd -> codex` に近いテンポを保てる

## UI States

### 1. 初期状態

- title 未入力
- workspace 未選択
- `StartNewSession`は無効
- 何を選べば開始できるかを短く示す

### 2. workspace 選択済み

- launch profile が有効

### 3. 開始直前

- `title / workspace / provider / character` を確認して開始する
- 誤起動しない程度の確認だけ残す

## Relation With Window Architecture

- `HomeWindow`
  - 既存セッションへ戻る導線と、新しく始める導線をまとめる管理面
- `SessionWindow`
  - launch 完了後に開く作業面
- `NewSessionLaunch`
  - `HomeWindow`のdialog / popupとして表示する

MVP では`HomeWindow`上部の＋iconの`NewSession`からdialogを開く形が妥当。

## Recommended Mock Direction

React モックでは次の形がよい。

- `HomeWindow`上部に＋iconの`NewSession`ボタン
- ボタン押下で `LaunchDialog` を表示
- `LaunchPanel` 内に
  - workspace path
  - session title
  - browse ボタン
  - SessionFolder ボタン
  - provider / character
  - start action

## Current Snapshot

- 現在の Home UI では上部バーに＋iconの`NewSession`を置いている
- `LaunchPanel` 自体は modal dialog で維持できる
- `Browse` は Electron 実行時に OS の directory picker を開く
- Agent Mode の `SessionFolder` は path を事前確定せず、WithMate 管理下の SessionFolder を workspace にする選択として扱う
- title は空文字で開き、入力必須
- provider は launch dialog 内で chip 選択し、enabled provider が 0 件なら start できない
- Home の `NewSession`、Character authoring、Auxiliary の provider picker は同じ状態境界を使う。取得中は picker 内の spinner と busy / accessible statusだけを表示して開始buttonをdisabledにし、取得失敗はprovider errorだけをalertで示して開始不可にする。取得成功後の0件だけ作成不可の説明を表示し、loading / error / ready 0 件を同じ空状態として扱わない。開始処理中は各確定button内のspinnerとbusyだけを示し、busyをalertへ変換しない
- Home `NewSession`、Character authoring、Auxiliary の launch-section は意味上のgroupとして維持するが、装飾用のnested cardを描画しない
- `Character` は意味のあるoption cardで切り替える。必要な識別情報は残すが、入れ子の装飾cardは作らない
- `Character` はportrait付きoption cardで切り替える
- Character一覧の先頭にランダム選択cardを置く。ランダム選択時は、通常Sessionの最終利用順を使い、最近使っていないactive Characterほど高い重みで抽選する
- ランダム選択時は、開いている通常Session Windowで使用中のCharacterを、他にactive Characterがある間は候補から除外する。すべて使用中の場合は重複を許容する
- Character利用履歴がない場合は使用中を除いた抽選候補を均等に抽選し、active Characterが0件なら既存のneutral fallbackを使う
- Session履歴の読み込み中または取得失敗時はランダム選択で開始せず、取得成功した0件と区別する
- 開いている通常Session Window一覧の読み込み中または取得失敗時もランダム選択で開始せず、取得成功した0件と区別する
- `Character` selector は Random と active Character のoption cardを表示する。selector内に検索入力や常設説明文は置かない
- Character 0件時は neutral fallback を表示し、正常なempty説明文を表示しない
- launch dialog 内のcharacter cardもHomeと同じtheme ruleを使う
  - background = character `main`
  - left accent bar = character `sub`
  - foreground = background から自動コントラスト決定
- model / depth / approval / sandbox / custom agent は launch dialog には出さず、Main Process が選択中 provider の直近 Session 一件から解決する。Home の履歴キャッシュは実行設定の正本にせず、最終選択の検証から永続化までは Settings / model catalog の変更と直列化する。SessionFolder の準備は排他の外で行い、準備中の storage または選択の変更は保存前に検出して作成を拒否する。詳細は ADR 007 を参照する
- session 作成直後の UI 表示も `AutoRun / ProviderControlled / SafetyFocused` の provider-neutral wording に揃える
- ランダム選択の補足説明は表示せず、選択結果だけを示す
- `provider` は session 作成時に明示保存する
- `StartNewSession`を押すと、入力したtitleを持つ新規session recordを作って`SessionWindow`を開く。作成中は同じ確定button内のspinnerとbusy/accessibility statusだけで待機を示し、別の重複状態文を出さない
- Main Process は directory / SessionFolder のどちらでも Session ID を発行し、ID 衝突時に既存 record を上書きしない
- `SessionFolder` 選択時は `session-files/{sessionId}` を新規 directory として作成してから、その path を `workspacePath` として session record を保存する
- 最初の依頼は Launch Dialog ではなく `Session Window` のメインチャットから入力する

## Future Direction

- SessionFolder の orphan cleanup が必要になった場合は、永続 Session から参照されない directory だけを対象にした maintenance として追加する

## Next Step

- `HomeWindow`内で`RecentSessions`と視線競合しない配置に調整する
