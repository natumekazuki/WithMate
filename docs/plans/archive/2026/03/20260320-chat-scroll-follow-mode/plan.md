# Plan

## Goal

- Session のチャット欄で、新着レスポンス時のスクロール挙動を UX 観点で自然なものにする
- 末尾付近では自動追従し、読み返し中は現在位置を維持する条件付き follow mode を定義する
- coding agent のリアルタイム性と、過去メッセージ読解のしやすさを両立する

## Current Baseline

- 現行 `src/App.tsx` は message list を `useLayoutEffect` で常時末尾へスクロールしている
- scroll effect の主トリガーは `selectedSession.id`, `displayedMessages.length`, `liveRun.assistantText`, `liveRun.steps.length`
- `assistantText` や `liveRun.steps` の更新で再描画されるが、follow / off を分ける state は存在しない
- `liveRun.steps` は length 以外の変化（status / summary / details）を scroll トリガーにしていない
- 既存 CSS に follow mode 用の状態表現や新着通知導線はない

## Scope

- Session Window の message list scroll 挙動
- 新着 assistant message / pending 更新 / live run step 更新時の追従条件
- `末尾追従中` と `読み返し中` の判定ルール
- `selectedSession.id` 切替時の follow state リセット
- `新着あり` 導線の要否判断と、必要な場合の最小導線
- 関連 design doc と実機テスト項目

## Out of Scope

- メッセージ本文レンダリングそのものの変更
- audit log や diff window の scroll 制御
- virtualization や大規模な list 基盤変更

## UX Principle

- ユーザーが末尾付近にいるときは、新着に自然に追従する
- ユーザーが上へスクロールして読み返しを始めたら、勝手に末尾へ飛ばさない
- 追従停止中に新着が来ても、読む位置を壊さずに「新着あり」だけ分かるようにする
- coding agent UI として、実況を追いたいときは追いやすく、読み返したいときは邪魔しないことを優先する

## Behavior Definition

- `末尾付近` は、表示中 viewport の下端と message list の最下端の差分が `80px` 以下の状態とする
- follow mode は、初期表示時および `selectedSession.id` 切替時に `ON` へリセットする
- ユーザーが上方向へスクロールして bottom gap が `80px` を超えたら `読み返し中` とみなし、follow を `OFF` にする
- ユーザーが手動で末尾へ戻る、または bottom gap が再び `80px` 以下になったら follow を `ON` に戻す
- `liveRun.steps` の更新は、length だけでなく、各 step の `status / summary / details` 変化も「新しい表示内容」として扱う
- ただし、見た目に影響しない再描画だけでは scroll state を切り替えない
- follow `OFF` 中に新着が来た場合は current position を維持し、`新着あり` 導線で追従復帰できるようにする
- `新着あり` 導線は必要とする。最小構成は「新着あり / 末尾へ移動」の単一アクションでよい

## Task List

- [x] Plan を作成する
- [x] 現行の message list 常時末尾追従の baseline を確認する
- [x] `末尾付近` の閾値と follow mode 切替条件を定義する
- [x] `liveRun.steps` 更新の判定範囲を決める
- [x] `新着あり` 導線の要否を決める
- [x] Session message list の scroll 制御を更新する
- [x] design doc / manual test を更新する
- [x] 実装の実機検証を行う

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Risks

- 閾値が狭すぎると、末尾追従したいのに止まりやすい
- 閾値が広すぎると、読み返し中なのに勝手に末尾へ飛びやすい
- pending bubble の更新頻度が高いため、判定を雑にすると scroll のちらつきが起こる
- `liveRun.steps` の status / summary / details 変化まで含めると、更新頻度が高い場面で再追従が多くなる可能性がある
- `新着あり` 導線を足す場合、Session UI の情報密度を上げすぎる可能性がある
- `selectedSession.id` 切替時の state reset を忘れると、別 session へ follow 状態が持ち越される恐れがある

## Design Doc Check

- 状態: 更新完了
- 対象候補: `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- メモ: Session の scroll follow mode は user intent に応じて切り替わる仕様として同期する
