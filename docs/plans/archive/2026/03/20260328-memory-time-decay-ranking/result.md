# Result

- 状態: 完了

## Summary

- `Project Memory` と `Character Memory` の retrieval に時間減衰を追加した
- `lastUsedAt ?? updatedAt` を参照する共通 score 補正で古い記憶の価値を段階的に下げるようにした
- relevance が十分高い古い記憶は残るように段階的補正に留めた

## Verification

- `node --test --import tsx scripts/tests/project-memory-retrieval.test.ts scripts/tests/character-memory-retrieval.test.ts scripts/tests/character-reflection.test.ts scripts/tests/provider-prompt.test.ts`
- `npm run build`

## Notes

- 実装 slice
