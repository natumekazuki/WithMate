# Companion History Display 実装 Result

- status: completed
- started: 2026-04-26
- completed: 2026-04-26

## 結果

- Home の Companion 一覧に active / history の区分を追加した。
- active CompanionSession は Review Window を開ける操作カードとして表示し、merged / discarded / recovery-required は read-only history card として表示するようにした。
- 専用 history table は追加せず、既存 `companion_sessions.status` と `updated_at` を使う。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit`
- `npx tsx --test scripts/tests/companion-storage.test.ts`
- `npm run build`
- `npm test`

## コミット

- `bc9d513` `feat(companion): merge discard 履歴を Home に表示する`
