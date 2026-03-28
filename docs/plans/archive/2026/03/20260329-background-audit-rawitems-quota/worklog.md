# Worklog

- background adapter result に `rawItemsJson` と optional な `providerQuotaTelemetry` を追加
- `memory-orchestration-service` で background audit log 更新時に `rawItemsJson` と quota field を反映
- `session-runtime-service` で通常 turn audit log 更新時にも Copilot quota field を反映
- `audit-log-quota.ts` を追加して main/background 共通の quota field 付与ロジックを共通化
- `memory-orchestration-service.test.ts` を更新
- `session-runtime-service.test.ts` を更新
- `audit-log.md` に current 実装を追記
- 2026-03-29: `75a88d9` `feat(session): refine audit and monologue monitoring`
  - main/background 両方の quota field と raw items 監査を同一 feature commit に含めた
