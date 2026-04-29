# V2 runtime read-path / phase 4 Green

- Scope: V2 runtime read-path / phase 4
- Mode: green
- 変更方針: V2 DB を basename `withmate-v2.db` で検知し、V2 runtime の read-path は `SessionStorageV2Read` / `AuditLogStorageV2Read` のみ使用。V1 write 系ファクトリーは呼ばない。
- Updated files:
  - `src-electron/persistent-store-lifecycle-service.ts`
  - `src-electron/main.ts`
  - `src-electron/main-session-persistence-facade.ts`
  - `src-electron/session-storage-v2-read.ts`
  - `src-electron/audit-log-storage-v2-read.ts`
  - `scripts/tests/persistent-store-lifecycle-service.test.ts`
  - `docs/plans/20260427-identify-data-loading-optimizations/files/i-v2-g4/progress.md`
  - `docs/plans/20260427-identify-data-loading-optimizations/files/i-v2-g4/proposal/design.md`
  - `docs/plans/20260427-identify-data-loading-optimizations/files/i-v2-g4/result.md`
  - `docs/plans/20260427-identify-data-loading-optimizations/files/i-v2-g4/proposal/summary.md`

## 検証
- `npx tsx --test scripts/tests/persistent-store-lifecycle-service.test.ts`
- `npx tsx --test scripts/tests/app-database-path.test.ts scripts/tests/session-storage-v2-read.test.ts scripts/tests/audit-log-storage-v2-read.test.ts scripts/tests/session-storage.test.ts scripts/tests/audit-log-storage.test.ts`
- `npm run build:electron`

結果:
- `persistent-store-lifecycle-service` suite 10件 -> pass
- 追加指定テスト群 -> pass
- build:electron -> pass
