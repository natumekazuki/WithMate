# Plan

## Goal

- 現在の baseline を前提に、Session Window の pending bubble を visibility-first 方針で仕上げ直し、実装へそのまま着手できる計画に更新する
- すでに入っている `status / type` label、bucket sort、`details` 折りたたみ、usage footer、error block 分離は維持したまま、見直し対象を `file_change` 可視化の不足分へ絞る
- `assistantText`・live run 全体 usage・live run 全体 error という current code の責務分離を崩さず、「今なにを変えようとしているか」が追いやすい pending UI にする

## Scope

- Session Window の pending bubble 内 `live run` 表示
- 既存 `live run step` shell を前提にした `file_change` の見せ方強化
- `assistantText` と step list の責務整理を踏まえた文書更新
- 関連 design doc と実機テスト項目の同期

## Out of Scope

- 既存の `status / type` label、bucket sort、`details` 折りたたみ、usage footer、error block 分離をやり直すこと
- `agent_message` を live step list へ戻すこと
- `usage` や `errorMessage` を step 単位へ持たせる data model 変更
- artifact `Details` や operation timeline 全体の再設計
- audit log schema / live run event payload / assistant 本文レンダリングの変更

## Plan Review Conclusion

- blocking issue: なし
- review 反映の要点:
  - `operationTypeLabel()` 共有、status/type label、bucket sort、`details` 折りたたみ、usage footer、error block 分離は current code で概ね実装済み
  - stale になった「まず基礎 UI を整える」前提はこの plan から外す
  - `agent_message` は live step list ではなく `assistantText` として別表示される前提へ修正する
  - `usage` と `errorMessage` は step 単位ではなく live run 全体単位として扱う前提へ修正する
  - 追加で詰めるべき本題は `file_change.summary` の可視化強化と、それに合わせた validation / docs sync である

## Current Baseline

- `src/App.tsx` では `liveRun.steps` を bucket sort し、`failed / canceled / in_progress` を先頭、`completed` を後段、`pending` / 未知 status をさらに後段へ送っている
- `src/ui-utils.tsx` には `liveRunStepStatusLabel()` と `operationTypeLabel()` があり、pending bubble と artifact operation timeline で type label を共有済み
- pending bubble では step ごとの `details` が `<details>` で折りたたまれ、`liveRun.errorMessage` は step list から分離された alert block、`liveRun.usage` は footer 表示になっている
- `assistantText` は pending bubble 本文として step list の上に出ており、`agent_message` を live step list の 1 row として扱う構造ではない
- `file_change.summary` 自体は改行結合されたテキストとして届くが、現在 UI は単一 paragraph 表示のため、複数ファイル変更時の視認性が visibility-first として弱い

## Re-do Targets

### 1. 今回やり直す対象を限定する

- 既存 shell を前提に、`file_change` の可視化不足だけを再設計対象として明示する
- `command_execution`、`reasoning`、`todo_list` など既存 step の表示は、baseline を壊さないことを優先する
- 旧 task 由来の「まず label helper を共通化する」「usage / error を分離する」といった完了済み前提は削除する

### 2. `agent_message` の扱いを明記する

- pending bubble におけるエージェント本文は `liveRun.assistantText` で表示する
- 本 task では `agent_message` を live step list へ統合しない
- docs / validation でも「assistantText と step list は別レイヤー」という前提で確認項目を書く

### 3. `file_change` 可視化 task を具体化する

- `file_change` step の `summary` が改行結合の複数行を含む場合、単一 paragraph のままではなく、行ごとに scan しやすい見せ方へ変える
- 優先案:
  - `file_change` の summary を改行単位で分割し、変更対象ファイルを list / chips / line item として並べる
  - 可能な範囲で path と変更内容が一目で読める強弱を付ける
  - 1 行しかない場合やパースしづらい書式では raw summary fallback を維持する
- `details` は引き続き二次情報として折りたたみ、summary list と details の二重展開で高さが暴れないようにする
- `file_change` 以外の step は current baseline の summary 表示を維持し、不要な再設計を避ける

## UX Principle

- coding agent UI として、「いま何を触ろうとしているか」が pending 中に読めることを優先する
- ただし、すでに改善済みの label / sort / details / footer / error shell を壊してまで情報量を増やさない
- 常時表示するのは意図理解に効く要約情報、長い出力は二次情報へ逃がす
- `assistantText` は会話本文、step list は作業実況、usage / error は run 全体メタ情報として責務を分ける

## Implementation Outline

1. `file_change` step の summary 形式を前提に、複数行時の見せ方と raw fallback 条件を確定する
2. pending bubble の markup を、`file_change` のみ list 表示へ分岐できる構造へ更新する
3. CSS を、複数ファイル変更が scan しやすく、かつ pending bubble 全体の高さを押し上げすぎない方向で調整する
4. design doc / manual test を current baseline に合わせて同期し、`assistantText`・global usage/error・`file_change` 可視化を明記する

## Task List

- [x] current baseline と review 差分を plan に反映する
- [x] stale な前提を削除し、今回やり直す対象を `file_change` 中心へ絞る
- [x] `agent_message` / `assistantText`、global `usage` / `errorMessage` の扱いを明文化する
- [x] `file_change.summary` の行分割 / raw fallback ルールを決める
- [x] pending bubble markup を `file_change` 可視化方針へ更新する
- [x] pending bubble style を `file_change` list 表示に合わせて更新する
- [x] design doc / manual test を current baseline と実装結果に合わせて更新する
- [x] 検証を完了する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Risks

- `file_change.summary` の書式を過剰に仮定すると、provider 差分や未知フォーマットで情報欠落を起こす
- 改行分割した file list を常時展開しすぎると pending bubble の縦伸びが再発する
- `assistantText` と `file_change` list の両方が長い turn では、どちらが主情報か分かりにくくなる可能性がある
- docs が旧前提のままだと、「agent_message が step list に出る」「usage / error が step 単位」といった誤認を実装者へ残してしまう

## Validation

- 自動検証:
  - `npm run typecheck`
  - `npm run build`
- review:
  - 重大指摘なし
  - 軽微なテストギャップのみ
- 実機確認:
  - `assistantText` がある run で、本文表示と step list が重複せず、`agent_message` を step row として期待しないこと
  - `file_change` が単一行 summary の run で、既存より読みにくくならず raw fallback が破綻しないこと
  - `file_change` が複数行 summary の run で、各変更対象を paragraph 1 個より scan しやすく読めること
  - `command_execution` / `reasoning` / `todo_list` など非 `file_change` step の current baseline 表示が退行しないこと
  - `liveRun.usage` が引き続き footer 集約表示で、step row 側へ誤って複製されないこと
  - `liveRun.errorMessage` が引き続き step list と分離した alert block で、failed step と混線しないこと
  - `Cancel` / provider error / tool error を含む run でも sort / label / details の既存挙動が維持されること

## Docs Sync Check

- 状態: 更新対象あり
- 対象: `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- 同期ポイント:
  - `assistantText` と step list の分離
  - `usage` / `errorMessage` が live run 全体単位であること
  - `file_change.summary` の複数行可視化ルール
  - 既存 label / bucket sort / details / footer / error block を baseline として維持すること

## Completion Conditions

- 実装後も既存の label / sort / details / footer / error block が退行しない
- `file_change` の複数対象変更が pending bubble で scan しやすくなる
- docs / manual test が current baseline に一致する
- `npm run typecheck` と手動確認が通る

## Refactor Triage

- 判定: `same-plan`
- 対象: `file_change.summary` の整形 helper 抽出が必要になった場合の局所リファクタ
- 理由: 今回の完了条件である `file_change` 可視化強化の前提作業に留まるため
- 想定影響範囲: `src/App.tsx`, 必要なら `src/ui-utils.tsx`
- 検証観点: raw summary fallback 維持、非 `file_change` step 非退行、複数行 summary の scan 性向上
