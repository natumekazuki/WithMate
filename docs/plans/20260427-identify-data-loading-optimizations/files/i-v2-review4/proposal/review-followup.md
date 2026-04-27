# i-v2-review4 follow-up review

## Findings

No same-plan blockers found in the follow-up scope.

前回指摘した V2 DB mode の legacy memory table 混入は、`src-electron/memory-storage-v2-read.ts` と `src-electron/persistent-store-lifecycle-service.ts` の V2 分岐で解消されています。V2 mode では `SessionMemoryStorageV2Read` / `ProjectMemoryStorageV2Read` / `CharacterMemoryStorageV2Read` が使われ、V1 memory storage factories は呼ばれません。

前回指摘した空/未完成 `withmate-v2.db` による V1 shadowing も、`src-electron/app-database-path.ts` の required table validation で解消されています。空の V2 DB は V2 として選択されず、V1 path へ fallback します。

MemoryGeneration / Reflection の広い削除は、今回の依頼どおり本 plan の product decision として扱いました。その前提で、追加の具体的な runtime regression は見つけていません。

## TDD Evidence

- `scripts/tests/app-database-path.test.ts` は valid V2 priority と empty V2 fallback を確認している。
- `scripts/tests/persistent-store-lifecycle-service.test.ts` は V2 mode で V1 session/audit storage factories に加え、V1 memory storage factories も呼ばれないことを確認している。
- 同 lifecycle test は V2 initialize 後の `sqlite_master` に `session_memories`、`project_scopes`、`project_memory_entries`、`character_scopes`、`character_memory_entries` が作成されないことを確認している。

## Verification

実行:

```text
npx tsx --test scripts/tests/app-database-path.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts
```

結果:

```text
tests 14
pass 14
fail 0
```

## Follow-ups

前回記録済みの new-plan follow-up は残ります。

- audit pagination / lazy detail
- V2 write-path
- per-call open/close performance
