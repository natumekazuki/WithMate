# Plan

## Goal

- Electron 実機で `GitHub Copilot` provider が `CLI server exited unexpectedly with code 0` / `Connection is closed.` で失敗する原因を特定する
- app-level で必要なログを追加し、再現条件と failure point を追える状態にする
- workaround ではなく、次に打つ修正方針まで決める

## Scope

- `src-electron/copilot-adapter.ts` の session/client lifecycle 調査
- `src-electron/main.ts` の Session 実行経路調査
- 必要最小限の debug log / trace 追加
- 実機再現と切り分け結果の記録

## Out Of Scope

- Copilot capability の新規追加
- slash command 対応
- Session UI デザイン変更

## Task List

- [x] Plan を作成する
- [ ] 実機 failure の再現条件を整理する
- [ ] Copilot adapter / main process の failure point を追うログを追加する
- [ ] `npm run electron:start` で実機再現し、どこで closed になるかを確認する
- [ ] 原因と次アクションを `result.md` にまとめる

## Affected Files

- `src-electron/copilot-adapter.ts`
- `src-electron/main.ts`
- `scripts/tests/copilot-adapter.test.ts`
- `docs/plans/20260323-copilot-electron-runtime-debug/`

## Risks

- debug log を増やしすぎると本来のエラーが埋もれる
- Electron 実機と単体 smoke で挙動が違うため、片側だけ見ても原因を誤認しやすい
