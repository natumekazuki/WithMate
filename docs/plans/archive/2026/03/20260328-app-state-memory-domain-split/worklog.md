# Worklog

- 2026-03-28: plan 作成
- 2026-03-28: `src/memory-state.ts` を追加し、`Session / Project / Character Memory` と `Session background activity` の shared type / normalize helper / clone helper を切り出した
- 2026-03-28: `app-state.ts` は memory domain を再 export する構成へ整理し、Memory 系実装とテストの import を `memory-state.ts` 側へ寄せた
- 2026-03-28: `node --import tsx scripts/tests/session-memory-storage.test.ts`、`node --test --import tsx scripts/tests/character-reflection.test.ts scripts/tests/project-memory-retrieval.test.ts scripts/tests/provider-prompt.test.ts scripts/tests/project-memory-promotion.test.ts`、`npm run build` を通した
