# Plan

## Goal

- `GitHub Copilot` 実行中に `Connection is closed.` や `CLI server exited unexpectedly with code 0` が出ても、stale client / session を再生成して 1 回は自動復旧する
- Copilot provider が app 再起動前の古い connection state に引きずられにくいようにする

## Scope

- `src-electron/copilot-adapter.ts` の stale session / client recovery
- closed connection 判定 helper の追加
- 回帰テスト追加

## Out Of Scope

- Copilot capability 追加
- UI 文言変更
- SDK 本体 patch

## Task List

- [x] Plan を作成する
- [x] stale connection の判定条件を決める
- [x] session / client の再生成 retry を実装する
- [x] 回帰テストを追加する
- [x] typecheck / test / build で確認する

## Affected Files

- `src-electron/copilot-adapter.ts`
- `scripts/tests/copilot-adapter.test.ts`

## Risks

- retry 条件を広げすぎると、本来の provider error まで握りつぶす
- stale session だけでなく client も捨てないと再発する可能性がある
