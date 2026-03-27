# Worklog

- 2026-03-28: plan を開始。時間減衰を retrieval / ranking の score 補正として入れる。
- 2026-03-28: `memory-time-decay.ts` を追加し、`lastUsedAt ?? updatedAt` を参照する共通 score 補正を実装した。
- 2026-03-28: `Project Memory` と `Character Memory` の retrieval に時間減衰を接続した。
- 2026-03-28: `node --test --import tsx scripts/tests/project-memory-retrieval.test.ts scripts/tests/character-memory-retrieval.test.ts scripts/tests/character-reflection.test.ts scripts/tests/provider-prompt.test.ts` と `npm run build` で確認した。
- 2026-03-28: `bff0ba3` `feat(memory): Character Reflection と記憶 ranking を追加`
