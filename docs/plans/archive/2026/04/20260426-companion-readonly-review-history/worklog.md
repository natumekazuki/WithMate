# Companion Read-only Review History 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。
- `CompanionSessionSummary` に latest merge run を追加した。
- terminal CompanionSession の read-only review snapshot を latest merge run から生成するようにした。
- Home の history card を read-only Review Window 起動導線にした。
- Home の history card summary は latest merge run を優先して表示するようにした。
- `docs/design/companion-mode.md` と `docs/design/database-schema.md` を現行仕様に合わせて更新した。
- `npx tsc -p tsconfig.electron.json --noEmit` を実行し、成功した。
- `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-review-service.test.ts scripts/tests/companion-session-service.test.ts` を実行し、成功した。
- `npm run build` を実行し、成功した。
- `npm test` を実行し、成功した。

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion read-only review history | 0692e13 | terminal CompanionSession の read-only Review Window を追加する |
