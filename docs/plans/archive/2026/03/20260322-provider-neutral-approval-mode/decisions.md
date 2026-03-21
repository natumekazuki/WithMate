# Decisions

## Summary

- 本 task は「失われた provider-neutral approval mode 実装の same-plan 復元」であり、新規 task ではない
- 共通 approval mode は `allow-all / safety / provider-controlled` を採用し、default は `safety` とする
- `never / untrusted / on-request / on-failure` は read-path で normalize し、one-shot migration は行わない
- native policy 変換は adapter 境界に限定し、UI / Audit Log / Run Checks / approval chip は provider-neutral 表示へ統一する
- tests / docs sync は完了条件の一部として扱い、後回しの任意作業にしない
- same-plan artefact の復元後、feature commit 後 state を反映して archive する

## Decision Log

### 0001

- 日時: 2026-03-21
- 論点: 誤操作で失われた artefact は `same-plan` で復元するか、`new-plan` を起こすか
- 判断: `same-plan`
- 理由:
  - 消失したのは active plan artefact であり、task 自体の目的や受け入れ条件は変わっていないため
  - 変更範囲も引き続き approval mode 共通化、adapter boundary、UI / audit / docs / tests sync に留まるため
- 影響範囲: `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/plan.md`, `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/decisions.md`, `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/worklog.md`, `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/result.md`

### 0002

- 日時: 2026-03-21
- 論点: 共通 approval mode の canonical set を何にするか
- 判断: `allow-all / safety / provider-controlled`
- 理由:
  - provider 名や native policy 名を shared state と UI の正本へ持ち込まずに、共通意図で表現できるため
  - `allow-all` / `safety` / `provider-controlled` は user-facing な意味が比較的安定しており、provider-neutral 表示に向くため
- 影響範囲: `src/app-state.ts`, `src/App.tsx`, `src/HomeApp.tsx`, `src/settings-ui.ts`, `docs/design/desktop-ui.md`, `docs/design/session-launch-ui.md`

### 0003

- 日時: 2026-03-21
- 論点: 既存の legacy/native 値をどこで吸収するか
- 判断: read-path normalize で吸収し、one-shot migration は行わない
- 理由:
  - 既存 session / audit log に残る `never / untrusted / on-request / on-failure` を起動時に読めることが優先であり、まずは読み取り整合で互換性を担保すべきため
  - migration を追加すると task の責務が広がり、same-plan から外れる恐れがあるため
- 影響範囲: `src/app-state.ts`, `src-electron/session-storage.ts`, `src-electron/audit-log-storage.ts`

### 0004

- 日時: 2026-03-21
- 論点: native provider policy 変換をどこへ閉じ込めるか
- 判断: adapter 境界だけで変換する
- 理由:
  - provider ごとの差異を runtime 実行境界へ閉じ込めた方が、renderer / storage / docs を provider-neutral に保ちやすいため
  - current repo でも `src-electron/codex-adapter.ts` に native approval policy mapping が存在し、責務の寄せ先として自然なため
- 影響範囲: `src-electron/codex-adapter.ts`, `src-electron/main.ts`, `docs/design/provider-adapter.md`

### 0005

- 日時: 2026-03-21
- 論点: provider-neutral 表示の同期対象をどこまで同一 plan に含めるか
- 判断: UI、Audit Log、Run Checks、approval chip、tests、docs をすべて same-plan の完了条件に含める
- 理由:
  - approval mode の共通化は型や adapter だけ整えても user-visible 表示が旧 wording のままでは完了にならないため
  - 表示・監査・検証・文書のいずれかが旧値を残すと、provider-neutral 方針が崩れるため
- 影響範囲: `src/App.tsx`, `src/HomeApp.tsx`, `src/settings-ui.ts`, `src-electron/audit-log-storage.ts`, `docs/design/audit-log.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0006

- 日時: 2026-03-21
- 論点: approval mode 共通化に伴う局所リファクタを same-plan に含めるべきか
- 判断: normalize helper 抽出、表示ラベル helper 整理、adapter mapping 集約は `same-plan`
- 理由:
  - これらは元 task の完了条件を満たすための前提整理であり、独立した目的や検証軸を持たないため
  - 一方で provider capability matrix や policy negotiation の一般化は別 task が妥当であるため、current plan には含めない
- 影響範囲: `src/app-state.ts`, `src-electron/codex-adapter.ts`, `src/App.tsx`, `src/settings-ui.ts`

### 0007

- 日時: 2026-03-22
- 論点: feature commit 実施後の artefact を active のまま残すか archive するか
- 判断: archive する
- 理由:
  - implementation、docs sync、validation pass、review findings 0、feature commit 作成まで完了しており、task の完了条件を満たしているため
  - 残論点は approval prompt の体感差で明らかな bug が出た場合の follow-up のみであり、active plan として保持する理由がないため
- 影響範囲: `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/plan.md`, `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/worklog.md`, `docs/plans/archive/2026/03/20260322-provider-neutral-approval-mode/result.md`

## Follow-up Boundary

- `same-plan`
  - approval normalize helper の追加 / 集約
  - approval chip / Audit Log / Run Checks の表示統一
  - storage read-path normalize
  - adapter-only native conversion
  - feature commit 後 state の artefact close と archive
- `new-plan`
  - provider capability / approval policy matrix の恒久基盤化
  - 保存済み値の一括変換 migration
  - provider ごとの approval UX を個別最適化する別仕様
  - approval prompt の体感差で明らかな bug が出た場合の follow-up
