# Result

- 状態: 完了

## Summary

- `createSession / updateSession / deleteSession / upsertSession` を `SessionPersistenceService` に分離した
- `main.ts` は session CRUD の保存責務を service 呼び出しへ縮小した
- provider/model 解決、allowedAdditionalDirectories 正規化、scope 同期、副作用片付けを service に集約した

## Verification

- `node --test --import tsx scripts/tests/session-persistence-service.test.ts scripts/tests/session-window-bridge.test.ts scripts/tests/session-runtime-service.test.ts`
- `npm run build`

## Notes

- TDD first で進める
- `replaceAllSessions()` は follow-up slice に残した
