# Companion Review Timeline 実装 Result

- status: completed
- started: 2026-04-26
- completed: 2026-04-26

## 結果

- Review snapshot に session の merge runs を含めるようにした。
- Review Window に merge / discard timeline を追加した。
- terminal read-only Review Window は latest merge run を changed file summary に使い、同 session の merge runs を newest-first timeline で表示する。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit`
- `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-review-service.test.ts scripts/tests/companion-session-service.test.ts`
- `npm run build`
- `npm test`

## コミット

- `77ae968 feat(companion): review に merge run timeline を表示する`
