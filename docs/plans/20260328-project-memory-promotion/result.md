# Result

- 状態: 完了

## Summary

- `Session Memory` extraction 完了後に `Project Memory` へ昇格保存する rule-based promotion を実装した
- `decisions` は `decision` category として保存し、tag 付き `notes` だけを `constraint / convention / context / deferred` へ昇格する
- `goal / openQuestions / nextActions` は current slice では昇格対象にしない

## Verification

- `npm run build`
- `node --import tsx scripts/tests/project-memory-promotion.test.ts`
- `node --import tsx scripts/tests/session-memory-extraction.test.ts`
- `node --import tsx scripts/tests/project-memory-storage.test.ts`

## Notes

- 昇格は current slice では rule-based に限定する
- retrieval は follow-up とする
