# Decisions

- この slice は storage 自体の変更ではなく、`main.ts` からの依存を 1 箇所へ寄せる薄い service 分離に留める
- `SessionRuntimeService` と `MemoryOrchestrationService` の依存 shape は維持し、`main.ts` 側の adapter だけ差し替える
