# Decisions

- この slice は `AuditLogStorage` ではなく、runtime observability state の service 分離に絞る
- `main.ts` の public helper 名は極力維持し、内部実装だけ `SessionObservabilityService` に寄せる
- provider quota refresh の dedupe と delayed refresh timer も同じ service へ閉じ込める
