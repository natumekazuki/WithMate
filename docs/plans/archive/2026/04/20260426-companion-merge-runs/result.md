# Companion Merge Runs 実装 Result

- status: completed
- started: 2026-04-26
- completed: 2026-04-26

## 結果

- `companion_merge_runs` table と storage API を追加した。
- merge / discard 完了時に completed merge run を保存するようにした。
- main の CompanionReviewService wiring に merge run 保存依存を追加した。
- design doc と database schema doc を現行仕様に合わせて更新した。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit`
- `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-review-service.test.ts scripts/tests/companion-session-service.test.ts scripts/tests/main-ipc-deps.test.ts`
- `npm run build`
- `npm test`

## コミット

- d4983c8 `feat(companion): merge run 履歴を保存する`
