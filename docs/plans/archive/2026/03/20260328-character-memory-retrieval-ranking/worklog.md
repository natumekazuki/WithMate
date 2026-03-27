# Worklog

- 2026-03-28: plan を開始。Character Memory の retrieval を recent 順から query-based ranking へ切り替える。
- 2026-03-28: `character-memory-retrieval.ts` を追加し、recent conversation を query にした lexical retrieval を実装した。
- 2026-03-28: category weight、coverage、recent fallback、重複 suppression を加えた。
- 2026-03-28: assistant 側の汎用語に引っ張られないよう、user 発話を主 query とする ranking へ調整した。
- 2026-03-28: `node --test --import tsx scripts/tests/character-memory-retrieval.test.ts scripts/tests/character-reflection.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/settings-ui.test.ts` と `npm run build` で確認した。
- 2026-03-28: `bff0ba3` `feat(memory): Character Reflection と記憶 ranking を追加`
