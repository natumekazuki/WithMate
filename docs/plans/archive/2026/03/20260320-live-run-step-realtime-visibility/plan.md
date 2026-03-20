# Plan

## Goal

- Session Window の pending bubble で、コーディングエージェントの動きをリアルタイムに追える可視性を回復する
- `e63c911` 以降で弱くなった実況性を見直し、`pre-e63c911` 寄りの「見えている安心感」を戻す
- ただし、current baseline で有効な visibility 改善は壊さず、今回やり直す対象だけを明確にして実装可能な計画へ整える

## Scope

- Session Window の pending bubble 内 `live run step` 表示
- `command_execution / file_change / reasoning / todo_list / mcp_tool_call` の常時表示内容
- `details` 折りたたみ、`usage` footer、`errorMessage` block の扱い再整理
- `assistantText` が未着でも「動いている」と判断できる進行中表現
- `pre-e63c911` と current baseline の差分棚卸し
- 関連 design doc と実機テスト項目

## Out of Scope

- artifact `Details` や operation timeline 全体の再設計
- audit log schema / live run event payload 自体の変更
- assistant 本文レンダリングの変更
- provider ごとの event 生成仕様の変更

## Background

- `e63c911 feat(session-window): live run step 表示を整理` で、label 化、bucket sort、`details` 折りたたみ、usage footer、error block 分離が入った
- その方向性は一般チャット UI としては整っているが、coding agent UI としては「何をやろうとしているかが見えにくい」という問題を生んだ
- 実使用上は、安全性と信頼感の観点でも、コマンドや変更対象がリアルタイムに見えている方が価値が高い

## Current Baseline

- pending bubble は current baseline として以下を持つ
  - `status / type` label
  - bucket sort (`failed / canceled / in_progress` 先頭, `completed` 後段)
  - `details` 折りたたみ
  - `usage` footer 集約
  - `errorMessage` 分離 block
  - `file_change` は multi-line summary を list 変換する visibility-first 改善済み
- current code では `command_execution.summary = item.command` で command 自体は data / UI 上に存在する
- ただし command は plain paragraph 扱いで dedicated styling が弱く、`completed` 時に muted されるため、「安全確認のために見たい情報」としては視認性が不足している
- `assistantText` は step list とは別系統のため、未着の時間帯に live run step 側だけで進行中感を成立させる必要がある

## This Iteration でやり直す対象

- `command_execution` を「見えてはいるが十分に見やすくない」状態から、安全確認に使える主表示へ引き上げる
- `assistantText` 未着時でも pending bubble の step 情報だけで進行中と判断できる構成を明文化する
- `details` / `usage` / `errorMessage` の役割分担を、visibility-first の前提で再整理する
- `pre-e63c911` と current baseline の UI 差分を棚卸しし、何を戻し、何を current として残すかを明示する
- 既存の `file_change` visibility-first 改善は current baseline として保持し、今回の見直しで壊さない

## UX Principle

- `command_execution` は隠さず、実際のコマンド文字列を常時見せる
- `file_change` は対象ファイルや変更要約を常時見せる
- `in_progress` は最も目立たせ、ユーザーが「今やっていること」を即座に把握できるようにする
- 長い stdout / stderr や冗長な補足だけを二次情報として折りたたむ
- coding agent UI としての可観測性を、一般的なチャット UI の静けさより優先する
- `assistantText` がまだなくても、step の順序・強調・状態表示だけで「停止ではなく進行中」と読めることを優先する

## Approach

- ベースは `pre-e63c911` の「実況が見える状態」に寄せる
- ただし、以下は必要なら維持する
  - `status` の人間向けラベル
  - `errorMessage` の独立 block
  - unknown 値 fallback
- `file_change` の list 化済み visibility-first 改善は維持前提とし、今回の再設計で退行させない
- bucket sort、summary 主表示、details 折りたたみは「可視性を損なうなら戻す / 緩める」前提で再評価する
- `command_execution` は plain paragraph のまま残さず、専用 styling または command 向け強調パターンを前提に再設計する
- `usage` は全体 footer 集約を baseline としつつ、主表示を圧迫しない位置に限定する
- `errorMessage` は failed/canceled 文脈を補助する独立 block として扱い、通常進行中の視線を奪わない配置を維持する

## Step-Type 方針

### `command_execution`

- command 文字列は常時表示対象とする
- `in_progress` / `completed` いずれでも command の可読性を保ち、完了時に本文ごと過度に muted しない
- shell command として一目で分かる見た目を持たせ、通常説明文と視覚的に区別する
- 長い補足や追加 metadata がある場合のみ `details` 側へ逃がす

### `file_change`

- current baseline の list 表示を維持する
- multi-line summary が paragraph 1 個へ退行しないことを前提にする
- 今回は command visibility 改善と整合する範囲でのみ見直し、独立した再設計は行わない

### `reasoning / todo_list / mcp_tool_call`

- 今何をしているかが分かる summary は常時表示する
- 冗長な補足や raw payload 相当は `details` 側へ寄せる
- `assistantText` 未着でも pending bubble の実況列として機能することを優先する

## Acceptance Criteria

### 共通

- pending bubble だけを見て、現在進行中の作業があるかどうかを判断できる
- `assistantText` 未着の turn でも、`in_progress` step の強調と step 内容から「動いている」ことが分かる
- `details` / `usage` / `errorMessage` は主表示を邪魔せず、必要時のみ補助情報として読める
- `file_change` の既存 visibility-first 改善を壊さない

### `command_execution` 専用

- command 文字列が plain paragraph に埋もれず、command であると視覚的に即判別できる
- `completed` 後も command が安全確認に使える視認性を維持し、過度な muted で読みにくくならない
- command 実行中は `assistantText` がまだ出ていなくても、「今どのコマンドを走らせようとしているか / 走らせているか」が pending bubble から追える
- command に付随する詳細情報は必要に応じて `details` に分離されてもよいが、主要な command 文字列自体は常時表示から外さない
- provider 差分で summary が乏しい場合に備え、必要なら `src-electron/codex-adapter.ts` を含むデータ整形の確認ポイントを持つ

## Delta Audit

- `pre-e63c911` と current baseline の差分棚卸しを、少なくとも以下の観点で明文化する
  - step type ごとの常時表示要素
  - `command_execution` の styling / emphasis 差分
  - `details` に送られた情報と常時表示へ残すべき情報
  - sort / muted / completed state が視認性へ与える影響
- 差分棚卸しの結果、UI 層だけで不足を埋められない場合に限り、`src-electron/codex-adapter.ts` を条件付き affected file として扱う

## Task List

- [x] Plan を作成する
- [x] `pre-e63c911` と current baseline の差分を、`command_execution` / muted state / details 送り込み情報を中心に棚卸しする
- [x] 常時表示する情報と折りたたむ情報を step type ごとに定義し、`details` / `usage` / `errorMessage` の責務を整理する
- [x] `assistantText` 未着時でも進行中感が成立する UI 条件を定義する
- [x] `pre-e63c911 + current baseline で残す改善点` の差分方針を確定する
- [x] pending bubble の markup を visibility-first に更新する
- [x] pending bubble の style を visibility-first に更新する
- [x] 必要なら data 整形の不足有無を確認し、UI だけで不足する場合は `src-electron/codex-adapter.ts` 対応要否を判断する
- [x] design doc / manual test を更新する
- [x] 実装と検証を完了する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `src/ui-utils.tsx`
- `src-electron/codex-adapter.ts`（条件付き: UI 層だけでは `command_execution` の表示要件を満たせない場合のみ）
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Refactor Triage

- 判定: `same-plan`
- 対象: pending bubble 内 step 表示の markup / style / 必要時の event 整形確認
- 理由: 今回の不足は「同じ live run step 可視性改善タスク」の完了条件に直結しており、独立した目的や検証軸ではない
- 想定 follow-up 候補: live run event schema 自体の再設計、timeline 全体の再構成、provider 横断の payload 標準化
- follow-up 判定条件: UI 要件を満たすために event schema 変更や広域 refactor が必要になった場合は `new-plan` に分離する

## Risks

- リアルタイム表示を戻しすぎると pending bubble が縦に伸びる
- provider によっては summary / details の粒度が粗く、raw 表示が荒れる可能性がある
- `assistantText` と実況 step の両方が長い turn では、主従関係が曖昧になる可能性がある
- command の強調を増やしすぎると completed step 群のノイズが増える
- `details` / `usage` / `errorMessage` の再配置次第で current baseline の整理効果を失う可能性がある

## Validation

- `npm run typecheck`
- `npm run build`
- 実機確認:
  - `assistantText` 未着の状態でも、pending bubble だけで進行中と判断できること
  - command 実行中に、何を実行しようとしているかを pending bubble だけで追え、完了後も command が読めること
  - `command_execution` が通常 paragraph と区別できる dedicated styling を持つこと
  - file change 発生中に、対象ファイルや要約が current baseline の list 表示から退行しないこと
  - 長い details があっても bubble 全体が破綻せず、主表示が埋もれないこと
  - `usage` footer が主表示を邪魔せず、run 全体の補助情報としてまとまっていること
  - `errorMessage` と failed step の見た目が混線しないこと
  - `pre-e63c911` と current baseline の差分方針どおりに「戻すもの / 残すもの」が説明できること

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- メモ:
  - `docs/design/desktop-ui.md`: pending bubble における `command_execution` 常時表示、`assistantText` 未着時の進行中感、`details / usage / errorMessage` の責務を同期する
  - `docs/manual-test-checklist.md`: command 実行中、assistantText 未着、completed 後の command 視認性、file_change list 維持、error / cancel の各確認ケースを追加または更新する
