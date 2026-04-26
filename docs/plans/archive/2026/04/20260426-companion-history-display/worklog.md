# Companion History Display 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。
- Home の Companion 一覧を active と history に分け、terminal CompanionSession は read-only card として表示するようにした。
- Companion の検索対象に status / runState / provider / model などを含めた。
- terminal CompanionSession が `listSessionSummaries()` に残り、`listActiveSessionSummaries()` から除外されることを storage test で確認した。
- `docs/design/companion-mode.md` と `docs/design/database-schema.md` を current 実装に合わせて更新。
- 検証:
  - `npx tsc -p tsconfig.electron.json --noEmit`
  - `npx tsx --test scripts/tests/companion-storage.test.ts`
  - `npm run build`
  - `npm test`

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion history display | `bc9d513` | merge / discard 済み CompanionSession を Home 履歴として表示する |
