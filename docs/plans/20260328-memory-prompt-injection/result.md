# Result

- 状態: 完了

## Summary

- `Session Memory` を coding plane prompt へ常設注入するようにした
- `Project Memory` を lexical retrieval で最大 3 件まで注入するようにした
- prompt の論理順序を `System Prompt -> Character -> Session Memory -> Project Memory -> User Input` に current 実装として揃えた

## Verification

- `npm run build`
- `node --import tsx scripts/tests/project-memory-retrieval.test.ts`
- `node --import tsx scripts/tests/provider-prompt.test.ts`

## Notes

- current slice では retrieval を lexical match に限定する
