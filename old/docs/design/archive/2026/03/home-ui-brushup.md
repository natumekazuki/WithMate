# Home UI Brushup

## Status

- 状態: historical note
- current の UI 正本は `docs/design/desktop-ui.md`

- 作成日: 2026-03-14
- 対象: `Home Window` の UI 改善検討

## Goal

`Home Window` を一気に作り直すのではなく、要素単位で分解し、優先順位をつけて順番にブラッシュアップする。

Home の主目的は次の 3 つに限る。

1. 既存 session へ戻る
2. 新規 session を始める
3. character を管理する

visual direction は `黒基調の管理ハブ` とし、Session Window とは異なる温度感を持たせる。

## Current

2026-03-20 redesign 前の Home は、概ね次の 6 要素で構成されていた。

1. `Toolbar`
2. `Running / Interrupted Chips`
3. `Recent Sessions`
4. `Characters`
5. `New Session Dialog`
6. `Settings Overlay`

### Current facts

- `Settings` は Home 右ペイン上段の rail へ移動済み
- `New Session` / `Add Character` は各セクション action へ寄せる方向になっている
- ただし monitor 系 UI の truth source は renderer 派生になりがちで、`SessionWindow` を実際に開いている session だけを追う仕組みは薄い
- `Recent Sessions` card では `taskTitle / workspacePath / updatedAt` が主で、state badge や `taskSummary` 1 行補助の整理が不十分
- card sort 自体は storage 既定の `last_active_at DESC` を前提にしている
- `Characters` は同時並置より、monitor と right pane を共有する方が情報密度を抑えやすい

## Target

今回の redesign では、Home の情報設計を `左 Recent Sessions + 右 right pane` の 2 カラムへ整理する。

### 1. Recent Sessions

- Home の session 正本一覧は常に `Recent Sessions` card list とする
- `running` / `interrupted` / `error` / non-active を同一一覧へ残し、未知 state でも card を欠落させない
- Home の state precedence は次で固定する
  1. `status === "running"` または `runState === "running"`
  2. `runState === "interrupted"`
  3. `runState === "error"`
  4. それ以外は neutral な non-active
- card sort は storage 既定の `last_active_at DESC` を維持し、renderer で active state 優先へ組み替えない
- card 常時表示情報は `avatar / taskTitle / runState badge / workspacePath / updatedAt`
- `taskSummary` は 1 行の補助情報としてだけ扱い、空なら省略する
- card theme は既存どおり
  - background = character `main`
  - left accent bar = character `sub`
  - foreground = background から自動コントラスト決定

### 2. Session Monitor

- 右ペインの既定面として `Session Monitor` を置く
- right pane 上部の segmented toggle で `Session Monitor` / `Characters` を排他的に切り替える
- source は `src-electron/main.ts` の `sessionWindows: Map<string, BrowserWindow>` を truth source にした open session ids と、`Recent Sessions` と同じ filtered session list の交差集合を使い、search と乖離させない
- monitor panel は少なくとも次の 2 section を持つ
  - `実行中`: `running`
  - `停止・完了`: `interrupted` / `error` / `neutral` を含む non-running
- interrupted / error は non-running section に落としても、badge で判別できるようにする
- row は compact な shortcut とし、`avatar + taskTitle + workspace + state badge` を表示する
- row click で session を開ける既存導線を維持する
- open session が 0 件のときは、その状態が自然に読める empty state を right pane 内で示す

### 3. Characters

- right pane のもう片側として配置し、`Session Monitor` と同時表示しない
- `Add Character` は選択中の header action と empty state にだけ出す
- search input と list は `Characters` 選択中だけ表示する
- empty / no-result は pane 内で完結させる
- card 全体クリックで `Character Editor` を開く
- card theme は session card と同じ rule を使う
  - background = character `main`
  - left accent bar = character `sub`
  - foreground = background から自動コントラスト決定

### 4. New Session Dialog

含まれる要素:

- title input
- workspace picker
- character select
- start action

役割:

- session launch

現在の課題:

- launch に必要な情報は絞れているが、視線誘導はまだ改善余地がある
- `Browse` 後の選択内容表示を整理できる

改善観点:

- `title -> workspace -> character -> start` の順序を視覚的に強める
- confirmation 情報を軽くする

### 5. Settings Overlay

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

2026-03-20 時点で次の更新を反映済み。

- Home を `左 = Recent Sessions / 右 = Session Monitor または Characters` の 2 カラムへ更新した
- `Recent Sessions` は全 session を card list に残し、`running` / `interrupted` / `error` / non-active を同一一覧で見られるようにした
- 右ペイン上部に segmented toggle を置き、`Session Monitor` / `Characters` を排他的に切り替えるようにした
- `Session Monitor` は `実行中` と `停止・完了` の 2 section を維持しつつ、`sessionWindows` を truth source にした open session ids と `Recent Sessions` の検索結果の交差集合だけを表示するようにした
- SessionWindow を閉じた session は monitor から外れ、search 条件に外れた session も `Recent Sessions` と同時に外れるようにした
- `Recent Sessions` / `Characters` 見出しは Home 限定の色指定で dark background 上の可読性を回復した
- `Characters` の search / empty state / `Add Character` 導線は right pane 選択中に維持した
- Home 用の見た目調整は `.home-page` 配下に閉じ、Session Window への style bleed を避ける

## Related Documents

- `docs/design/desktop-ui.md`
- `docs/design/window-architecture.md`
- `docs/design/session-launch-ui.md`
- `docs/design/settings-ui.md`
