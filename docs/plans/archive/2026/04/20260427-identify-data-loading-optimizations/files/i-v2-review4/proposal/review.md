# i-v2-review4 review

## Findings

### [P1] V2 DB 起動時に V1 memory tables を作成・書き込み得る

- Files:
  - `src-electron/persistent-store-lifecycle-service.ts:79`
  - `src-electron/persistent-store-lifecycle-service.ts:80`
  - `src-electron/persistent-store-lifecycle-service.ts:81`
  - `src-electron/main.ts:681`
  - `src-electron/main.ts:682`
  - `src-electron/main.ts:683`
  - `src-electron/session-memory-storage.ts:95`
  - `src-electron/session-memory-storage.ts:97`
  - `src-electron/project-memory-storage.ts:100`
  - `src-electron/project-memory-storage.ts:106`
  - `src-electron/character-memory-storage.ts:87`
  - `src-electron/character-memory-storage.ts:93`
  - `src-electron/session-runtime-service.ts:396`
  - `docs/design/database-v2-migration.md:88`
  - `docs/design/database-schema.md:95`

`PersistentStoreLifecycleService.initialize()` は V2 判定時に session/audit だけを read adapter へ切り替えていますが、session/project/character memory storage は通常の V1 storage を同じ `dbPath` で生成します。これらの constructor は `CREATE_SESSION_MEMORIES_TABLE_SQL`、`CREATE_PROJECT_MEMORY_TABLES_SQL`、`CREATE_CHARACTER_MEMORY_TABLES_SQL` を実行するため、`withmate-v2.db` を開くだけで V2 正本 schema から除外されている legacy memory table が作られます。

さらに turn 実行では `SessionRuntimeService` が provider 実行前に `getSessionMemory()` を呼び、`SessionMemoryStorage.ensureSessionMemory()` が default memory を insert し得ます。その後 V2 read-only session/audit write guard が発火しても、先に V1 memory row だけが V2 DB に残る可能性があります。これは今回の same-plan focus である「accidental V1 writer against V2 schema」に該当します。

Recommended same-plan fix: V2 DB mode では memory 系 storage も V2 用 read-only/null adapter に差し替えるか、legacy memory を明示的に V1 DB へ分離して開く。少なくとも `createPersistentStoreLifecycleService()` を通した V2 schema integration test を追加し、`initialize()` 後の `sqlite_master` に `session_memories`、`project_scopes`、`project_memory_entries`、`character_scopes`、`character_memory_entries` が増えないことを検証してください。

### [P1] V2 read-path slice が V1 の memory/reflection 挙動を削除している

- Files:
  - `src/withmate-ipc-channels.ts:39`
  - `src/withmate-window-api.ts:61`
  - `src-electron/main-session-command-facade.ts:34`
  - `src-electron/session-runtime-service.ts:617`
  - `src-electron/session-window-bridge.ts:79`
  - `scripts/tests/session-runtime-service.test.ts:346`
  - `scripts/tests/session-runtime-service.test.ts:347`

今回の target は V2 runtime read-path ですが、差分では `runSessionMemoryExtraction` の IPC/API/facade 経路が削除され、turn 成功後の memory extraction / character reflection と session open 時 reflection も削除されています。テストも「background task は起動しない」期待へ変更されています。

V2 DB で write-path 未対応のため background write を止める必要があるとしても、この削除は DB mode で分岐しておらず、V1-only install の既存挙動まで変わります。これは same-plan focus の「broken existing V1 behavior」です。

Recommended same-plan fix: V1 mode では既存の manual memory extraction、turn 後 memory extraction、character reflection hook を維持し、V2 mode だけ明示的に disabled/read-only にする。V2 で memory/reflection を恒久削除する判断なら、V2 read-path とは独立した UX/API 変更なので new plan として切り出してください。

### [P2] `withmate-v2.db` の存在だけで V2 を選ぶため、空/未完成 DB が V1 を shadow して起動時 crash になり得る

- Files:
  - `src-electron/app-database-path.ts:7`
  - `src-electron/app-database-path.ts:8`
  - `src-electron/app-database-path.ts:12`
  - `src-electron/session-storage-v2-read.ts:197`
  - `scripts/tests/app-database-path.test.ts:15`
  - `scripts/tests/app-database-path.test.ts:18`

`resolveAppDatabasePath()` は `withmate-v2.db` が存在すれば無条件に V2 を返します。テストも空ファイルを作って V2 優先を確認しています。一方、V2 read adapter は `sessions` / `audit_logs` の存在を前提に SQL を実行するため、空ファイル、途中生成、schema 不一致の `withmate-v2.db` があると、健全な `withmate.db` が残っていても V2 が選ばれて起動時に SQLite error になります。

V2 migration script は partial DB を残さない方針ですが、runtime 側の read-path 切替としては schema validation がありません。V1 を rollback source として残す設計とも相性が悪いです。

Recommended same-plan fix: V2 を選択する前、または lifecycle initialize の冒頭で最低限の V2 schema marker/table validation を行い、無効な V2 DB なら V1 fallback か明示的な recoverable error にする。追加テストは「空の `withmate-v2.db` と正常な `withmate.db` がある場合に起動 crash しない」を含めてください。

## New-Plan Follow-Ups

- audit pagination / lazy detail: `AuditLogStorageV2Read.listSessionAuditLogs()` は既存 IPC contract 維持のため detail も復元している。ページング API と detail 遅延取得は別 validation axis として new plan が妥当。
- V2 write-path: session/audit の V2 writer は未実装で、現 slice では read-only guard が正しい。V2 書き込み対応は schema invariant と migration/update test を含む独立 plan にする。
- per-call open/close performance: V2 read adapter は呼び出しごとに DB を open/close する。startup race 回避としては理解できるが、接続管理・performance 測定は別 plan で扱う。

## TDD Evidence

- Adequate: `app-database-path.test.ts` は V1/V2 path priority を確認している。
- Adequate: `session-storage-v2-read.test.ts` は summary/detail DTO 復元、message/artifact 復元、broken JSON の skip/throw を確認している。
- Adequate: `audit-log-storage-v2-read.test.ts` は sessionId filter、id desc、detail/operation/usage/missing detail 復元を確認している。
- Adequate for session/audit lifecycle only: `persistent-store-lifecycle-service.test.ts` は V2 で V1 `SessionStorage` / `AuditLogStorage` を生成しないことを確認している。
- Missing: real lifecycle factory が V2 DB に legacy memory tables を作らない guard。
- Missing: V1 mode で manual/background memory/reflection が維持される regression test。
- Missing: 空/不完全 `withmate-v2.db` が V1 を shadow して起動 crash しない validation test。

## Design / Slice Assessment

- `docs/design/database-v2-migration.md` と `docs/design/database-schema.md` の V2 read-path 方針は session/audit について概ね実装に反映されている。
- ただし V2 正本 schema から legacy memory tables を除外する設計に対し、runtime lifecycle が V1 memory storages を同一 V2 DB に生成する点は design drift。
- V2 write-path 未切替の対策として V1 の memory/reflection runtime behavior を全体削除している点は slice granularity drift。V1 維持と V2 read-only guard を同じ plan 内で分離する必要がある。
