# Companion Sibling Warning History 実装 Result

- status: completed
- started: 2026-04-26
- completed: 2026-04-26

## 結果

- `companion_sessions.sibling_warnings_json` に merge 完了時の sibling warning summary を保存するようにした。
- merge 完了時は sibling warning を保存し、discard 完了時は空配列で保存するようにした。
- Home の terminal 履歴カードに sibling warning summary を表示するようにした。
- design doc と database schema doc を現行仕様に合わせて更新した。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit`
- `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-review-service.test.ts scripts/tests/companion-session-service.test.ts`
- `npm run build`
- `npm test`

## コミット

- ceadf2c `feat(companion): sibling warning を履歴に表示する`
