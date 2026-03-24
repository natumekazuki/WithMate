# Worklog

## 2026-03-24

- 起票: custom agent picker の表示条件と選択中表示を調整する
- `src-electron/custom-agent-discovery.ts` で `user-invocable` frontmatter を parse し、picker 用一覧は `true` の agent だけを返すようにした
- `src/App.tsx` と `src/styles.css` で `Agent` ボタン自体のラベルを現在選択中 agent 名へ置き換え、未選択時は `Default Agent` を出すようにした
- `scripts/tests/custom-agent-discovery.test.ts` に `user-invocable` フィルタのケースを追加した
- `docs/design/provider-adapter.md` と `docs/manual-test-checklist.md` を更新した
- `node --import tsx scripts/tests/custom-agent-discovery.test.ts` と `npm run build` で検証した
