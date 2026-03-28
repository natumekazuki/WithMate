# Plan

- 目的: `main.ts` に残っている memory 周辺の generic helper を service に分離する
- 完了条件:
  - `syncSessionMemoryForSession`、scope 同期、project retrieval、character memory 保存、monologue append が service 化される
  - `SessionPersistenceService` と `MemoryOrchestrationService` が新 service 経由で動く
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - retrieval / ranking ロジックそのものの仕様変更
