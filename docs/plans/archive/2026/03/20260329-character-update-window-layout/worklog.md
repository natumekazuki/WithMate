# Worklog

- 開始: Character Update Window を SessionWindow ライクな 2 面構成へ寄せる
- 実装: linked update session projection helper を追加し、`LatestCommand / MemoryExtract` の 2 面 UI に更新
- 検証: `npm run build`
- 検証: `node --test --import tsx scripts/tests/character-update-projection.test.ts scripts/tests/character-update-workspace-service.test.ts`
- コミット: `a572f9f` `feat(character): add update workspace monitor and session kind`
