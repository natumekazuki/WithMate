# Plan

## Goal

- Session 実行中の `live run step` 表示を、本文の邪魔をしない進捗表示へ整理する
- `status / type` の生っぽい表示を、人間向けに読めるラベルへ置き換える
- 進行中の step を把握しやすくしつつ、完了済み step の情報量を抑える

## Scope

- Session Window の pending bubble 内 `live run step` 表示
- `status / type / summary / details / usage / errorMessage` の見せ方
- 関連 design doc と実機テスト項目

## Out of Scope

- assistant 本文や artifact `Details` 全体の情報設計見直し
- audit log schema や live run event payload 自体の変更
- operation timeline 全体の UI 再設計

## Plan Review Conclusion

- blocking issue: なし
- 現状確認:
  - pending bubble の live run step 表示は `src/App.tsx` に集約され、見た目調整は `src/styles.css` が主担当
  - 現在の pending bubble は `status / type / summary / details / usage / errorMessage` をほぼ生のまま表示している
  - artifact operation timeline 側には `operationTypeLabel()` があり、type の人間向けラベル化ロジックは既に存在する
- 実装可否:
  - 重大な blocking issue は見つかっておらず、表示ルールを明文化すれば実装へ進める

## Current Findings

- 対象 UI は `src/App.tsx` の pending bubble と `src/styles.css` の `live-run-*` スタイルに閉じている
- pending bubble では `liveRun.steps` を配列順のまま描画し、各 step で `step.status` と `step.type` をそのまま文字列表示している
- `usage` は footer に `input / cached / output` を常時 3 要素表示している
- `errorMessage` は bubble 下部へ単純表示されている
- operation timeline 側の type label は `src/App.tsx` ローカル helper であり、pending bubble との共通化余地がある

## Presentation Rules

### 1. `status` label table

- `in_progress` → `実行中`
- `completed` → `完了`
- `failed` → `エラー`
- `canceled` → `キャンセル`
- `pending` → `待機`
- 上記以外の未知 status は raw 値 fallback を維持し、実装時は neutral 表示に倒す

### 2. `type` label policy

- 推奨案: operation timeline の label ルールを pending bubble にも流用し、共通 helper へ寄せる
- 採用理由: pending bubble と artifact timeline で同じ operation type が別表記になるズレを防げるため
- 実装前提:
  - `operationTypeLabel()` を `src/ui-utils.tsx` へ移し、pending bubble と timeline の両方から参照する
  - 未知 type は raw 値 fallback を維持する

### 3. `in_progress / completed` の並び替え・強弱

- 描画順ルール:
  - 問題系 / 実行系 bucket を先頭に置く: `failed` / `canceled` / `in_progress`
  - `completed` は後段へ寄せる
  - 同一 bucket 内では元の配列順を維持し、実行順の意味を壊さない
- 視覚強弱:
  - `in_progress` はもっとも強い accent とし、`status + type + summary` を常時見せる
  - `completed` は subdued 表現にして、既定では summary を主表示、details は二次情報として弱く扱う
  - `failed` / `canceled` は alert 系の見た目で active row と同等以上に視認性を確保する

### 4. `usage` の表示範囲

- pending bubble では step ごとの usage 展開は行わず、footer の集約値だけを扱う
- 既定表示は `input` と `output`
- `cached` は値が 0 より大きい場合のみ表示対象とする
- token 数は progress 補助情報のため、step 本文より弱い見た目にする

### 5. error / cancel path

- `liveRun.errorMessage` は step list と独立した alert block として扱い、summary 群に埋もれさせない
- cancel 完了時は pending bubble の active step 表示が残留しないことを確認する
- failed / canceled step が来るケースでは status label / 強調色 / details の見え方を通常完了と分離して検証する

## Validation

- `npm run typecheck`
- 実機確認:
  - `in_progress` と `completed` が混在する run で、active step が先頭かつ最も目立つこと
  - 複数 completed step がある run で、summary 中心の subdued 表示になり本文を押し下げすぎないこと
  - usage あり / cached 0 / cached > 0 の各ケースで footer 表示が意図通り分岐すること
  - provider 側エラーまたは tool error で `errorMessage` と failed step 表示が破綻しないこと
  - `Cancel` 実行後に pending bubble が stale 状態を残さず、監査ログ側の canceled 記録と矛盾しないこと
  - pending bubble と operation timeline で type label が一致すること

## Task List

- [x] Plan を作成する
- [x] 現行の `live run step` 表示要素とデータ構造を確認する
- [x] `status / type` の表示ラベル方針を決める
- [x] `in_progress` / `completed` の表示優先度を再設計する
- [x] `details` / `usage` / `errorMessage` の強弱と検証観点を整理する
- [ ] `src/ui-utils.tsx` へ operation type label helper を移し、pending bubble / timeline で共通利用する
- [ ] pending bubble の markup を表示ルールに合わせて更新する
- [ ] pending bubble の style を表示ルールに合わせて更新する
- [ ] design doc / manual test を更新する
- [ ] 実装と検証を完了する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `src/ui-utils.tsx`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Risks

- 実況表示を畳みすぎると、実行中に何が起きているか逆に追いづらくなる
- 表示ラベルを増やしすぎると、最終 artifact の operation timeline と責務が重複する
- `details` の扱いを誤ると、長い出力で pending bubble が再び肥大化する
- pending bubble と timeline の label helper を別管理のまま進めると、用語差分が再発しやすい

## Refactor Triage

- 判定: `same-plan`
- 対象: `operationTypeLabel()` の `src/ui-utils.tsx` への移設
- 理由: 今回の完了条件である「pending bubble の type 表示を人間向けラベルへ統一すること」を満たす前提作業だから
- 想定影響範囲: `src/App.tsx`, `src/ui-utils.tsx`
- 検証観点: pending bubble と artifact operation timeline の type label 一致、未知 type fallback 維持

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- メモ: Session の pending 中 progress UI について、status/type label、usage footer、error/cancel の確認手順を task ごとに同期する
