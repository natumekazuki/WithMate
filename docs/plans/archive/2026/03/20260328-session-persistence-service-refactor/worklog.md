# Worklog

- 2026-03-28: plan を開始。`createSession / updateSession / deleteSession / upsertSession` の保存責務を `SessionPersistenceService` に分離する。
- 2026-03-28: `src-electron/session-persistence-service.ts` を追加。provider/model 解決、allowedAdditionalDirectories 正規化、session memory / project scope / character scope 同期を service に寄せた。
- 2026-03-28: `scripts/tests/session-persistence-service.test.ts` を追加。create、update、delete の副作用を先に固定した。
- 2026-03-28: `d44f2fa` `refactor(session): extract runtime and persistence services`
  - `SessionPersistenceService` に CRUD / upsert の責務を寄せ、`main.ts` を service 呼び出しへ差し替えた。
