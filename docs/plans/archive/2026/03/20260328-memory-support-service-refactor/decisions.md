# Decisions

- `Project / Character Memory` の storage は直接隠蔽しすぎず、main process の composition root で依存注入する
- `SessionMemorySupportService` は保存・昇格・再利用の bridge に限定し、trigger 判定は `MemoryOrchestrationService` に残す
