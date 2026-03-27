# Result

- 状態: 完了

## Summary

- `Project Memory` の persistence foundation を実装した
- `project_scopes` と `project_memory_entries` を SQLite に追加した
- `workspacePath` から `git | directory` の project scope を解決して、session 保存時と app 起動時に同期するようにした
- reset target に `project memory` を追加した

## Verification

- `npm run build`
- `node --import tsx scripts/tests/project-memory-storage.test.ts`
- `node --import tsx scripts/tests/reset-app-database-targets.test.ts`

## Notes

- current slice では `Session -> Project` の昇格と retrieval は未実装
