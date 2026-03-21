# Plan

## Goal

- `provider-neutral approval mode` の plan artefact を、feature commit 後の完了状態へ同期して archive する
- feature commit `9fd8407fd43ff7e0032bef3eb783ee8369cbfd8d` (`feat(approval): 承認モードを provider-neutral 化`) 実施済みであることを artefact へ反映する
- 今後は approval prompt の体感差で明らかな bug が出た場合のみ follow-up で扱える状態に閉じる

## Scope

- `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/` 配下の `plan.md` / `decisions.md` / `worklog.md` / `result.md`
- feature commit 後 state の記録整備
- archive 完了状態の反映
- session workspace `plan.md` の同期

## Out of Scope

- provider-neutral approval mode 本体コードの追加修正
- 新しい validation pass の追加実行
- 新規 commit の作成
- approval prompt の体感差に対する事前最適化

## Confirmed Current State

- feature commit `9fd8407fd43ff7e0032bef3eb783ee8369cbfd8d` (`feat(approval): 承認モードを provider-neutral 化`) は作成済みである
- provider-neutral approval mode の same-plan 実装は、共通 mode、default `safety`、legacy/native 値の read-path normalize、adapter-only native conversion、provider-neutral UI / Audit Log / Run Checks / approval chip、tests / docs sync まで完了している
- validation は `npm run typecheck`、`npm run build`、`npx tsx --test scripts/tests/approval-mode.test.ts scripts/tests/audit-log-storage.test.ts scripts/tests/session-storage.test.ts` の pass を feature commit 前後の完了状態として記録済みである
- quality review は review findings 0 で完了している
- plan artefact は archive 配下へ移動済みである

## Recommended Approach

- feature commit 後の確定状態を `worklog.md` / `result.md` / `decisions.md` に反映する
- implementation recovery 完了後に残っていた commit 未実施・archive 未実施の記述を閉じる
- approval prompt の体感差に関する論点は、明らかな bug が確認された場合のみ follow-up へ切り出す

## Acceptance Criteria

### 1. 共通 approval mode を定義できる

- 共通 mode は `allow-all / safety / provider-controlled` の 3 値とする
- default は `safety` とする
- provider ごとの native policy 名を UI や shared state の正本にしない
- 達成状況: 完了

### 2. legacy/native 値を read-path で normalize できる

- legacy/native 値 `never / untrusted / on-request / on-failure` を read-path で共通 mode へ normalize できる
- `Session` と `AuditLog` を含む approval mode 読み出し箇所で同じ normalize 方針を使う
- 既存データを書き換える one-shot migration は追加しない
- 達成状況: 完了

### 3. native policy 変換は adapter 境界に限定できる

- provider 実行時に必要な native approval policy 変換は adapter 境界だけで行う
- renderer、shared state、UI、docs は native policy 名に直接依存しない
- provider-specific な分岐が adapter 境界の外へ漏れない
- 達成状況: 完了

### 4. 表示を provider-neutral に統一できる

- UI の approval 表示は provider-neutral wording に揃う
- Audit Log の approval 表示は provider-neutral wording に揃う
- Run Checks の approval 表示は provider-neutral wording に揃う
- approval chip は provider-neutral wording に揃う
- 達成状況: 完了

### 5. migration なしで既存データを扱える

- read-path normalize により既存の legacy/native 値をそのまま読み出せる
- one-shot migration を前提にしない
- backward compatibility は read-path で担保する
- 達成状況: 完了

### 6. tests / docs が同期される

- approval normalize と adapter mapping の検証を tests へ反映する
- provider-neutral 表示へ更新した UI / Audit Log / Run Checks / approval chip の期待値を tests へ反映する
- `docs/design/` と `docs/manual-test-checklist.md` を current target に同期する
- 達成状況: 完了

## Same-plan / New-plan Boundary

- 判定: `same-plan`
- 理由:
  - 今回の artefact 整備対象は、失われた active artefact の復元から feature commit 後 state の archive までであり、元 task の目的・変更範囲・完了条件を変更していないため
  - 実装対象も引き続き approval mode の共通化、read-path normalize、adapter-only native conversion、UI / audit / docs / tests sync に閉じているため
- same-plan に含めるもの:
  - shared approval mode 型 / normalize helper の導入または更新
  - session / audit log / settings など read-path の normalize
  - adapter 境界での native approval policy 変換
  - UI / Audit Log / Run Checks / approval chip の provider-neutral 表示
  - docs / manual test / automated test の同期
  - feature commit 後 state の artefact close と archive
- `new-plan` へ分けるもの:
  - provider ごとに approval policy の意味自体を再定義する仕様変更
  - 保存済み row を一括更新する migration task
  - approval policy を超えた provider capability negotiation 基盤の新設
  - approval prompt の体感差で明らかな bug が出た場合の follow-up

## Task List

- [x] `docs/plans/20260322-provider-neutral-approval-mode/` artefact を same-plan で復元する
- [x] `plan.md` / `decisions.md` / `worklog.md` / `result.md` を current task 向けに整備する
- [x] same-plan 判定と、誤操作による artefact 消失の文脈を artefact へ記録する
- [x] session workspace `plan.md` を current task に合わせて更新する
- [x] provider-neutral approval mode の shared representation を `allow-all / safety / provider-controlled` で定義する
- [x] default approval mode を `safety` に揃える
- [x] legacy/native 値 `never / untrusted / on-request / on-failure` の read-path normalize を session / audit / 関連 state に反映する
- [x] native approval policy 変換を adapter 境界だけへ閉じ込める
- [x] UI / Audit Log / Run Checks / approval chip の provider-neutral 表示を同期する
- [x] one-shot migration を追加しない方針のまま整合を確認する
- [x] tests を同期する
- [x] docs を同期する
- [x] `npm run typecheck` / `npm run build` と必要な tests の pass を artefact へ反映する
- [x] quality review findings 0 を artefact へ反映する
- [x] feature commit `9fd8407fd43ff7e0032bef3eb783ee8369cbfd8d` を記録する
- [x] `result.md` / `worklog.md` を完了状態へ更新する
- [x] `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/` へ archive する

## Completion State

- active plan artefact の再作成: 完了
- same-plan 判定の復元: 完了
- incident 記録: 完了
- session workspace 同期: 完了
- 実装復旧: 完了
- docs sync: 完了
- tests 同期: 完了
- repo 検証: 完了
- quality review: review findings 0
- feature commit 記録: 完了
- archive: 完了
- archive-ready: 達成

## Affected Files

- `src/app-state.ts`
- `src/App.tsx`
- `src/HomeApp.tsx`
- `src/settings-ui.ts`
- `src-electron/session-storage.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/main.ts`
- `docs/design/provider-adapter.md`
- `docs/design/audit-log.md`
- `docs/design/desktop-ui.md`
- `docs/design/session-launch-ui.md`
- `docs/manual-test-checklist.md`
- `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/plan.md`
- `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/decisions.md`
- `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/worklog.md`
- `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/result.md`

## Risks

- read-path normalize 漏れがあると、既存の `on-request` / `never` などが画面や監査ログで混在する
- adapter 境界の外で native policy 文字列を扱い続けると、provider-neutral 表示と実行時 policy が二重管理になる
- default を `safety` へ寄せる際に、旧 default `on-request` 前提の UI / tests / docs が残ると齟齬が出る
- one-shot migration を行わないため、normalize helper の適用漏れは実データで即座に表面化する
- 今後 approval prompt の体感差で明らかな bug が見つかった場合は follow-up が必要になる

## Validation

- feature commit 前後の完了状態として pass を記録済み:
  - `npm run typecheck`
  - `npm run build`
  - `npx tsx --test scripts/tests/approval-mode.test.ts scripts/tests/audit-log-storage.test.ts scripts/tests/session-storage.test.ts`
- 補足:
  - quality review は review findings 0
  - 今回の archive 更新では追加の code 変更検証は行っていない

## Design Doc Check

- 状態: 同期済み
- 対象候補: `docs/design/provider-adapter.md`, `docs/design/audit-log.md`, `docs/design/desktop-ui.md`, `docs/design/session-launch-ui.md`, `docs/manual-test-checklist.md`
- docs-sync 判定:
  - `docs/design/`: 更新済み
  - `README.md`: 更新不要
  - `.ai_context/`: 更新不要
- メモ:
  - feature commit 後 state の artefact close と archive まで完了
