# Home UI Brushup

- 作成日: 2026-03-14
- 対象: `Home Window` の UI 改善検討

## Goal

`Home Window` を一気に作り直すのではなく、要素単位で分解し、優先順位をつけて順番にブラッシュアップする。

Home の主目的は次の 3 つに限る。

1. 既存 session へ戻る
2. 新規 session を始める
3. character を管理する

visual direction は `黒基調の管理ハブ` とし、Session Window とは異なる温度感を持たせる。

## Current Structure

現状の Home は、概ね次の 6 要素で構成されている。

1. `Toolbar`
2. `Running / Interrupted Chips`
3. `Recent Sessions`
4. `Characters`
5. `New Session Dialog`
6. `Settings Overlay`

## Element Breakdown

### 1. Toolbar

含まれる要素:

- `Characters` の上に置く `Settings` rail

役割:

- Home 全体の主要アクションへの入口

現在の課題:

- `Settings` 以外の action をここへ置くと、各セクションの文脈と競合しやすい

改善観点:

- `Settings` は独立 header ではなく、右カラム上段の専用 rail に置く
- `New Session` と `Add Character` はそれぞれのセクションへ移す

### 2. Running / Interrupted Chips

含まれる要素:

- `running` session chips
- `interrupted` session chips

役割:

- 今すぐ戻るべき session のショートカット

現在の課題:

- `Recent Sessions` 本体との視線競合がある
- chip 群としての意味はあるが、情報密度の整理余地がある

改善観点:

- `priority sessions` として 1 セクションに再整理する
- `running` と `interrupted` の視覚差をさらに明確にする
- session card 群との重複情報を減らす

### 3. Recent Sessions

含まれる要素:

- avatar
- task title
- state
- workspace
- updatedAt
- task summary

役割:

- resume picker の本体

現在の課題:

- `taskSummary` の存在感がやや強い
- card の縦サイズが少し大きい
- `workspace / updatedAt / state` の優先度差が弱い

改善観点:

- resume 判断に必要な情報だけを再優先付けする
- card 密度を上げつつクリック対象を保つ
- `priority sessions` との役割分担を再調整する
- card の theme rule を固定する
  - background = character `main`
  - left accent bar = character `sub`
  - foreground = background から自動コントラスト決定

### 4. Characters

含まれる要素:

- search input
- avatar
- name
- `Add Character`

役割:

- character の選択前確認
- editor 起動入口

現在の課題:

- Home では session resume 面積と競合しやすい
- 常時一覧であるべき密度かは再検討余地がある
- card 内情報の縦方向の重心が安定していない

改善観点:

- search input と `Add Character` を同じ toolbar にまとめる
- 常設一覧の密度を下げる
- card を `Recent Sessions` と同じ温度感へ寄せる
- Home の card では name だけを見せ、description は editor 側へ寄せる
- card 全体クリックで `Character Editor` を開く
- 必要なら fold / collapse を検討する
- session card と同じ theme rule を使う
  - background = character `main`
  - left accent bar = character `sub`
  - foreground = background から自動コントラスト決定

### 5. New Session Dialog

含まれる要素:

- workspace picker
- character select
- approval select
- start action

役割:

- session launch

現在の課題:

- launch に必要な情報は絞れているが、視線誘導はまだ改善余地がある
- `Browse` 後の選択内容表示を整理できる

改善観点:

- `workspace -> character -> approval -> start` の順序を視覚的に強める
- confirmation 情報を軽くする

### 6. Settings Overlay

含まれる要素:

- `System Prompt Prefix`
- `Import Models`
- `Export Models`

役割:

- app-level settings

現在の課題:

- 今後設定が増える前提の整理が必要
- `System Prompt Prefix` と `Model Catalog` の grouping をもっと明確にできる

改善観点:

- section grouping を先に決める
- 将来項目追加に耐える余白を確保する

## Brushup Order

優先順位は次の順が自然。

1. `Toolbar`
2. `Recent Sessions`
3. `Running / Interrupted Chips`
4. `New Session Dialog`
5. `Characters`
6. `Settings Overlay`

## Rationale

### Toolbar first

Home の第一印象と主要導線を決めるから。
ここが曖昧なままだと、他の要素を整えても全体の重心が定まらない。

### Recent Sessions second

Home の主価値は resume picker なので、ここが最重要。
最も面積を使っており、改善効果も大きい。
現行 UI では `Recent Sessions : Characters` は `6 : 4` 前後が最も安定しやすい。

### Running / Interrupted Chips third

Recent Sessions の上位概念として整理すると効くが、まず本体 card 側の優先順位を決めてから詰めた方がよい。

### New Session Dialog fourth

起動導線として重要だが、Home 常設面の密度調整を先にやった方が判断しやすい。

### Characters fifth

必要な面だが、Home の主目的に対しては session resume / launch より一段優先度が下がる。

### Settings Overlay sixth

機能的には必要だが、日常操作の主軸ではない。
Home 本体の情報設計が固まってから十分。

## Recommended Next Slice

次に着手する slice は `Toolbar + Recent Sessions` の同時改善がよい。

理由:

- Home 全体の重心を決められる
- 最も目に入る領域と、最も価値の高い領域を一度に整えられる
- その後の `priority sessions` や `Characters` の面積配分も決めやすくなる

## Applied Update

2026-03-14 時点で次の更新を反映済み。

- 独立した header / toolbar は削除
- `Settings` は `Characters` の上に専用 rail を切って配置
- `New Session` は `Recent Sessions` セクションへ移動
- `Add Character` は `Characters` セクションへ移動
- `Characters` は `Edit` ボタンを持たず、card 全体クリックで editor を開く
- Home / Session の主要 UI はフラット寄りの配色へ更新
- Home は `.home-page` 配下で dark token を上書きし、Session 側の配色とは分離する

## Related Documents

- `docs/design/desktop-ui.md`
- `docs/design/window-architecture.md`
- `docs/design/recent-sessions-ui.md`
- `docs/design/session-launch-ui.md`
- `docs/design/settings-ui.md`
