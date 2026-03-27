# Result

- 状態: 完了

## Summary

- Project Memory retrieval を日本語 query に強い lexical scoring へ更新した
- prompt に注入した entry の `lastUsedAt` を更新するようにした

## Verification

- `npm run build`
- `node --import tsx scripts/tests/project-memory-retrieval.test.ts`
- `node --import tsx scripts/tests/project-memory-storage.test.ts`
- `node --import tsx scripts/tests/provider-prompt.test.ts`

## Notes

- current slice では FTS / vector / decay は入れない
