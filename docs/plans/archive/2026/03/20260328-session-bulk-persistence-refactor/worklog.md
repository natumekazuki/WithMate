# Worklog

- 2026-03-28: plan を開始。`replaceAllSessions()` と migration / rollback / reset 側の session write path を `SessionPersistenceService` に寄せる。
- 2026-03-28: `SessionPersistenceService.replaceAllSessions()` を追加。bulk replace、removed session cleanup、provider thread invalidation を service に移した。
- 2026-03-28: `scripts/tests/session-persistence-service.test.ts` に bulk replace のケースを追加。provider change / removed session / invalidation を固定した。
