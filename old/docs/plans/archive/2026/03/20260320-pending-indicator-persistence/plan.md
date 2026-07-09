# Plan

## Goal

- Session 実行中の pending bubble で、typing indicator (`...`) を本文出力開始後も維持し、実行中であることを視覚的に分かりやすくする
- `assistantText` の有無と「まだ実行中か」を分離し、stream 開始直後の不自然な表示切替をなくす
- persistence の対象を「同一 run の実行中表示継続」に限定し、再起動後や復元後の persistence は扱わない
- coding agent UI として、処理継続中の安心感を高める

## Scope

- Session Window の pending bubble 表示条件と、その中での indicator 系 UI の継続表示条件
- typing dots と `live-run-shell-status` を含む「実行中であることを示す要素」の扱い
- 本文と indicator の共存レイアウト
- 関連 design doc と実機テスト項目

## Out of Scope

- live run step 全体の情報設計見直し
- assistant 本文レンダリングの変更
- 他画面の loading indicator 変更
- app 再起動後 / 画面再マウント後 / session 復元後の indicator persistence

## Current Baseline

- pending bubble 全体は `selectedSession.runState === "running"` の間だけ表示される
- typing dots は `!liveRun?.assistantText && orderedLiveRunSteps.length === 0` のときだけ表示される
- `live-run-shell-status` は `!liveRun.assistantText && hasInProgressLiveRunStep` のときだけ表示される
- そのため `assistantText` が出始めると、run が継続中でも indicator 系 UI はすべて消える
- 今回の差分は「pending bubble の restart persistence」ではなく、「同一 run 中に assistantText が出ても実行中 indicator を継続表示する」ことにある

## Intended Change

- pending bubble 全体の表示可否は従来どおり `runState` を基準に扱う
- indicator の消失条件は success 固定ではなく `runState !== "running"` として明文化する
- `assistantText` の出力開始後も、run が継続している限り indicator 系 UI を維持する
- 本文・step 表示・indicator が同時に存在しても、情報の優先順位が崩れない見せ方にする

## UX Principle

- 実行中は「まだ動いている印」が常に見えている方が自然
- 本文が少しでも出た瞬間に indicator が消えると、完了したように見えて不安定
- indicator は本文の代替ではなく、実行中フラグとして扱う
- indicator は `runState !== "running"` になったら消す

## Acceptance

- run 開始直後、本文未出力でも pending bubble と indicator が見える
- 本文出力開始後も、`runState === "running"` の間は indicator が残る
- run が success / error / canceled などで `runState !== "running"` になったら indicator は消える
- restart persistence は実装しないことが plan 上でも明確である
- 既存 scroll follow mode を壊さず、streaming 中の表示追加で不自然な自動スクロール回帰を生まない

## Task List

- [x] Plan を作成する
- [x] 現行の pending bubble indicator 表示条件を確認する
- [x] 実行中 indicator の表示継続条件を定義する
- [x] 本文と indicator の共存レイアウトを設計する
- [x] Session pending bubble 実装を更新する
- [x] design doc / manual test を更新する
- [x] 実装と検証を完了する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Risks

- indicator を目立たせすぎると本文読みの邪魔になる
- indicator の位置が悪いと、step list や assistantText と競合して見える
- `runState` 遷移と表示条件がずれると、完了後も残留する可能性がある
- 既存 scroll follow mode と干渉すると、streaming 中の追従 / 非追従挙動に回帰が入る可能性がある
- ARIA / live region の更新頻度が増えると、再アナウンス過多で可読性を下げる可能性がある

## Validation

- design doc に「indicator は assistantText の代替ではなく、`runState === "running"` の実行中フラグ」であることを反映する
- manual test に少なくとも以下を追加する
  - run 開始直後: 本文なし・step なしでも pending bubble と typing indicator が見える
  - streaming 開始後: `assistantText` が増え始めても indicator が残る
  - step 進行中: `live-run-shell-status` と本文が共存しても崩れない
  - run 終了: success だけでなく `runState !== "running"` になった時点で indicator が消える
  - scroll follow regression: 末尾追従中は新着と indicator 更新で自然に追従し、読み返し中は不必要に末尾へ引き戻されない
  - accessibility: streaming 中に ARIA / live region が過剰に再通知されない
- review 時は「本文が出た瞬間に indicator が消えないこと」と「run 終了後に残留しないこと」を最優先で確認する

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- メモ: Session pending bubble の「実行中インジケータは本文出力開始後も維持し、`runState !== "running"` で消す」仕様と、restart persistence が scope 外である点を同期する
