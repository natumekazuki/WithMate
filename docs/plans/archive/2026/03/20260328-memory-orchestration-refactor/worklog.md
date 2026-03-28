# Worklog

- 2026-03-28: plan を開始。`main.ts` に残っている Memory / Character の background orchestration を service に分離する。
- 2026-03-28: `src-electron/memory-orchestration-service.ts` を追加。`Session Memory extraction`、`Character reflection`、background audit / activity 更新を集約した。
- 2026-03-28: `scripts/tests/memory-orchestration-service.test.ts` を追加。Session Memory / Character reflection の主要経路を固定した。
- 2026-03-28: `src-electron/main.ts` から旧 orchestration 実装を削除し、service 呼び出しへ一本化した。
- 2026-03-28: `node --test --import tsx scripts/tests/memory-orchestration-service.test.ts scripts/tests/session-runtime-service.test.ts scripts/tests/session-window-bridge.test.ts scripts/tests/session-persistence-service.test.ts` と `npm run build` を実行し、通過を確認した。
- 2026-03-28: コミット `57764c2` `refactor(memory): extract orchestration service`
  - `MemoryOrchestrationService` を追加
  - `main.ts` の Session Memory / Character reflection orchestration を service 化
  - TDD で主要経路を固定
