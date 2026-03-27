# Result

- 状態: 完了

## Summary

- Character Memory retrieval / ranking を recent 順から query-based ranking へ切り替えた
- recent conversation を query にし、category weight、coverage、recent fallback、重複 suppression を追加した
- assistant 側の汎用語に引っ張られないよう、user 発話を主 query にした

## Verification

- `node --test --import tsx scripts/tests/character-memory-retrieval.test.ts scripts/tests/character-reflection.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/settings-ui.test.ts`
- `npm run build`

## Notes

- 実装 slice
