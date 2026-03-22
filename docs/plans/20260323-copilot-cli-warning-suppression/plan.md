# Plan

## Goal

- `GitHub Copilot` 実行時に CLI 子プロセスの warning だけで turn が失敗しないようにする
- `ExperimentalWarning: SQLite` のような process warning を抑止して、`code 0` の正常終了を false error にしない

## Scope

- `src-electron/copilot-adapter.ts` の Copilot client 起動 env 調整
- warning 抑止用 helper の追加
- 回帰テスト追加

## Out Of Scope

- Copilot capability の追加実装
- audit log schema 変更
- SDK 本体 patch

## Task List

- [x] Plan を作成する
- [x] warning 発生経路と回避方針を確定する
- [x] Copilot child process の env 抑止を実装する
- [x] 回帰テストを追加する
- [x] typecheck / test / build で確認する

## Affected Files

- `src-electron/copilot-adapter.ts`
- `scripts/tests/copilot-adapter.test.ts`

## Risks

- warning 抑止が広すぎると、child CLI の重要な warning も見えなくなる
- SDK 内部仕様に強く依存した回避だと将来の SDK 更新で再発する
