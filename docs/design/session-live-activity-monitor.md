# Session Live Activity Monitor

## Goal

- Session 実行中に、会話本文を潰さずに `command_execution` を常時確認できるようにする
- safety / trust 観点で必要な情報を `最新 command 1 件` に絞り、見落としや情報過多を減らす
- right pane を `Latest Command / Memory生成 / 独り言` の activity host にする

## Problem

`Activity Monitor` に live step 一覧を積む構成は、実況性は高いが safety monitor としては情報が多すぎる。

- command が多い turn では、どの command が今重要なのかが埋もれやすい
- assistant 本文、step 一覧、詳細ログが同じ右 rail で競合しやすい
- 「危ない command が走っていないかを見る」という用途に対して、一覧全体の scan cost が高い

## Design Summary

- pending bubble は引き続き `assistantText` と run indicator だけを表示する
- right pane は `Latest Command / Memory生成 / 独り言` の 3 面を持つ
- 手動切り替えは常時可能にする
- 自動切り替えは `running` を基準にする
  - `Latest Command` は session run 中を最優先で表示する
  - `Memory生成` は background memory extraction が `running` の時に自動表示する
  - `独り言` は将来の monologue 実行が `running` の時に自動表示する
- `Latest Command` は次の優先順で決める
  - 実行中なら `liveRun.steps` の最後の `command_execution`
  - 待機中なら直近 terminal Audit Log に含まれる最後の `command_execution`
- `Memory生成` は専用 background activity state を main process から受ける
- `独り言` は background activity と recent monologue stream を表示する
- それ以外の step list や詳細な実況履歴は right pane 常設から外し、確定後は artifact timeline / Audit Log を見る

## Layout

```mermaid
flowchart TB
  H[Header]
  H --> M
  M[Main Split]
  M --> C[Conversation]
  M --> R[Right Pane Tabs]
  M --> D[Action Dock]
```

### Conversation

- message list と pending bubble の専用面
- `assistantText` を読む主面として扱う
- `message follow` banner は既存どおり list 下端の導線に留める

### Right Pane Tabs

- wide desktop では右 pane に常設する
- 上部に 3 つの tab button を置く
  - `LatestCommand`
  - `Memory生成`
  - `独り言`

#### Latest Command

- 表示対象は 1 件だけ
- 内容は次に絞る
  - status badge
  - raw command text
  - source label (`live` / `last run`)
  - 危険度の rough badge (`DELETE / WRITE / NETWORK`)
  - 必要時だけ開く `details`
- `liveRun.errorMessage` がある時は card 内の alert として併記する

#### Memory生成

- `Session Memory extraction` の background activity を表示する
- 内容は次に絞る
  - status badge
  - summary
  - trigger / model / reasoning を含む `details`
  - failure 時の error block

#### 独り言

- `character reflection cycle` の background state を表示する
- session `stream` に保存された recent monologue を新しい順で表示する
- 将来の monologue plane へ差し替えやすい host として扱う

### Action Dock

- SessionWindow 下端の full-width 操作面
- 次を内包する
  - retry banner
  - attachment / skill toolbar
  - attachment chips
  - textarea と `Send / Cancel`
  - `Approval / Model / Depth`
  - sendability feedback

## Responsive Rules

### Desktop Width

- right pane の tab host を常設する
- `Action Dock` は左右ペインの下に full-width で置く
- splitter で会話面と right pane の幅を調整できる

### Narrow Width

- main split は縦 stack に戻す
- right pane は message list の下、`Action Dock` の上へ置く
- `Action Dock` は引き続き最下段に固定面として扱う

## Data Mapping

- provider adapter や `liveRun` schema は変更しない
- Renderer 側では `session-ui-projection` helper が `liveRun.steps` と terminal Audit Log から最新 command だけを抽出する
- `Memory生成` と `独り言` は session 単位の background activity state を main process から IPC event で受ける
- Copilot quota summary と active tab の badge / tone / 自動切り替えも `session-ui-projection` helper に寄せる
- command 以外の live step は right pane へ出さない

## Non-Goals

- full step timeline の常設表示
- `Character Stream` 本体実装
- command の危険度判定を完全自動化すること
- Audit Log の構造変更

## References

- `docs/design/desktop-ui.md`
- `docs/design/audit-log.md`
