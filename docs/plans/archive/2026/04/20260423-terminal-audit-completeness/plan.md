# Plan

- task: terminal audit completeness の review follow-up を進める
- date: 2026-04-23
- owner: Codex

## Repo Plan 採用理由

- review follow-up で実装 / 検証 / レビュー / コミット / archive を伴うため、repo plan として管理する
- P1 / P2 を同一 logical change として扱い、terminal row 再構築方針と回帰確認を 1 task で追跡するため

## 目的

- terminal 化で `runningAuditEntry` に蓄積した live 監査情報が欠落しないようにし、success（`completed`） / failed / canceled row の監査完全性を回復する
- completed row の `operations` merge と carry-over `backgroundTasks` の terminal 同期で live-only operation trace を欠落させず、`approval_request` / `elicitation_request` や `background-*` を historical trace として保持できるようにする

## スコープ

- `src-electron/session-runtime-service.ts`
- `scripts/tests/session-runtime-service.test.ts`
- 上記 2 ファイルに閉じる runtime fix / regression test 更新
- 検証、docs-sync 判定、レビュー記録、commit / archive 記録

## Out Of Scope

- terminal audit completeness と直接関係しない renderer / UI 変更
- `docs/design/`、`.ai_context/`、`README.md` の仕様更新（現時点では不要見込み）
- 今回の review follow-up と独立した別 task の refactor や機能追加

## 前提と根本原因

- 直前 task `docs/plans/archive/2026/04/20260423-pr82-review-fixes/` は archive 済みで、今回は追加 review follow-up の別 task として扱う
- terminal 化で `runningAuditEntry` に保持した live 監査情報を継承せず、薄い `result` / `partialResult` だけで terminal row を再構築していることが根本原因である
- terminal row は `runningAuditEntry` を base にし、success / failed / canceled では terminal payload が薄いときに `assistantText` / `operations` / `usage` / `threadId` を fallback する。completed row は terminal payload の `operations` を優先しつつ、`mergeTerminalAuditOperations` で terminal 側の重複を保持しながら base 側を件数差分だけ補完し、run 開始時 carry-over `backgroundTasks` も running audit / terminal row に同期して progress なし completed でも `background-*` を残す実装へ更新した

## Slice / Checkpoint

### Logical Change: terminal audit completeness の回復（P1 / P2 一体対応）

- primary files:
  - `src-electron/session-runtime-service.ts`
  - `scripts/tests/session-runtime-service.test.ts`
- checkpoint:
  - [x] terminal audit entry の field priority を整理し、`runningAuditEntry` base と fallback 対象（`assistantText` / `operations` / `usage` / `threadId`）の境界を確定した
  - [x] success（`completed`） / failed / canceled の terminal 化を修正し、terminal payload が薄い場合でも live 監査情報を欠落させないようにした
  - [x] completed row は terminal payload の `operations` を優先しつつ、terminal 側の重複を保持しながら base 側を件数差分だけ補完する merge に更新し、`approval_request` / `elicitation_request` を historical trace として保持しうる整理にした
  - [x] run 開始時 carry-over `backgroundTasks` を running audit にも同期し、progress なし completed でも `background-*` を terminal row に残すようにした
  - [x] `scripts/tests/session-runtime-service.test.ts` を更新し、同一 summary の `command_execution` 重複保持、progress なし completed の `elicitation_request` 保持、既存 `backgroundTasks` の履歴保持を含む回帰テストを固定した
  - [x] 検証コマンド、docs-sync 最終判定、自己レビュー、および review fix 後の focused revalidation / final full validation を完了した

## Affected Files

- `src-electron/session-runtime-service.ts`
- `scripts/tests/session-runtime-service.test.ts`

## Validation Plan

- [x] `npm run build`（初回検証、review fix 後 focused revalidation、追加 review fix 反映後の final full validation で成功）
- [x] `npx tsx --test scripts/tests/session-runtime-service.test.ts`（review fix 後 focused revalidation で 22/22 pass）
- [x] `npm test`（既存検証 398 tests passed、および追加 review fix 反映後の final full validation で成功）
- [x] terminal row の field priority / operation semantics を差分自己レビューで確認する

## Docs Sync

- 最終判定: `docs/design/` / `README.md` は更新不要、`.ai_context/` は repo 内に存在しないため追加更新不要
- 理由:
  - 対応は `src-electron/session-runtime-service.ts` と `scripts/tests/session-runtime-service.test.ts` の internal runtime fix / test 更新のみのため
  - 公開仕様やユーザー向け導線を変更していないため
- 実装後タスク:
  - [x] 上記判定を最終確認した

## Archive Check

- tier: repo
- 対象: docs/plans/archive/2026/04/20260423-terminal-audit-completeness/
- archive 先: docs/plans/archive/2026/04/20260423-terminal-audit-completeness/
- archive-ready: 完了
