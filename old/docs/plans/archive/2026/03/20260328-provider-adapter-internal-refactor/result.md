# 20260328 Provider Adapter Internal Refactor Result

## 状態

- completed

## 概要

- `CodexAdapter` の background 実行を共通 private helper へ整理し、`runSessionTurn` の stream state 更新を helper 化した
- `CopilotAdapter` の background 実行を共通 private helper へ整理し、`runSessionTurnOnce` の event 収集を accumulator helper へ整理した
- public interface は維持したまま、coding plane / background plane の内部境界を読みやすくした
- 対応コミット: `01261a0` `refactor(provider): simplify adapter internals`

## 検証

- `npm run build`
- `node --import tsx scripts/tests/copilot-adapter.test.ts`
