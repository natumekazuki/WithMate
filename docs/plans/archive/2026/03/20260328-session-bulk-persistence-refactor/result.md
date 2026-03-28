# Result

- 状態: 完了

## Summary

- `replaceAllSessions()` を `SessionPersistenceService` に分離した
- model catalog import / rollback、settings 更新、session reset の bulk write path を service 経由に揃えた
- removed session cleanup と provider thread invalidation も service に集約した

## Verification

- `node --test --import tsx scripts/tests/session-persistence-service.test.ts`
- `npm run build`

## Notes

- TDD first で進める
- `syncSessionsForCharacter()` はまだ follow-up に残した
