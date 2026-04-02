# 20260402-memory-management-ui Result

## status

- 完了待ち

## summary

- Settings Window から `Session / Project / Character Memory` を一覧・閲覧・削除できる管理 UI を追加した
- current scope は delete までとし、manual update は follow-up task `memory-management-manual-update` へ分離した

## commits

- なし

## verification

- `npm run build`
- `node --import tsx scripts/tests/session-memory-storage.test.ts`
- `node --import tsx scripts/tests/project-memory-storage.test.ts`
- `node --import tsx scripts/tests/character-memory-storage.test.ts`
- `node --import tsx scripts/tests/memory-management-service.test.ts`
- `node --import tsx scripts/tests/preload-api.test.ts`
- `node --import tsx scripts/tests/main-ipc-registration.test.ts`
- `node --import tsx scripts/tests/main-ipc-deps.test.ts`
- `node --import tsx scripts/tests/home-settings-projection.test.ts`
