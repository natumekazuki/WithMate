# Plan

## Goal

- Copilot approval 後に長時間 command が走る turn で `Timeout after 180000ms waiting for session.idle` にならないようにする
- approval UI 追加で導入した待機経路と、Copilot session の完了待機を切り分けて安定化する

## Scope

- `src-electron/copilot-adapter.ts` の turn 完了待機ロジック見直し
- 必要に応じた design / manual test の同期

## Out of Scope

- Codex provider の変更
- approval UI の見た目変更
- 実機 manual test の実施

## Task List

- [x] 失敗ログと現行 timeout 実装を確認する
- [x] Copilot turn の完了待機を fixed timeout 依存から外す
- [x] build で回帰確認する
- [x] docs 更新要否を判定する

## Affected Files

- `src-electron/copilot-adapter.ts`
- `docs/design/provider-adapter.md`
- `docs/manual-test-checklist.md`

## Risks

- timeout を外すだけだと、本当に hung した session を待ち続けるリスクがある
- `session.idle` / `session.error` / cancel のどれで待機を解くかが曖昧だと、partial result の回収が壊れる

## Design Doc Check

- 状態: 今回は更新不要
- 対象候補: `docs/design/provider-adapter.md`, `docs/manual-test-checklist.md`
- メモ: provider contract や UI surface は変えず、Copilot adapter の内部待機ロジックだけを fixed timeout 依存から外したため
