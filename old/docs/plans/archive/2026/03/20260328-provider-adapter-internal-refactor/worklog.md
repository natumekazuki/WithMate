# 20260328 Provider Adapter Internal Refactor Worklog

- 2026-03-28: task 開始。`codex-adapter.ts` と `copilot-adapter.ts` の `runSessionTurn / extractSessionMemoryDelta / runCharacterReflection` の内部 helper 境界を棚卸し。
- 2026-03-28: `CodexAdapter` に background prompt 共通 helper と turn stream state helper を追加。
- 2026-03-28: `CopilotAdapter` に background prompt 共通 helper と turn event accumulator helper を追加。
- 2026-03-28: `01261a0` `refactor(provider): simplify adapter internals`
  - `CodexAdapter` の background 実行と turn stream state を private helper に整理
  - `CopilotAdapter` の background 実行と turn event 集約を private helper に整理
  - build と adapter test を通過
