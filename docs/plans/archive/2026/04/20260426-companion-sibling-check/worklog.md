# Companion Sibling Check 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。直近コミットは `4741e7c`。
- sibling warning 型と merge result 型を追加。
- merge 後に同じ CompanionGroup の active sibling CompanionSession の changed files と selected files の path overlap を検出するようにした。
- sibling check が失敗しても selected CompanionSession の merge は完了し、warning として Review Window に返すようにした。
- Review Window に merge 後の sibling warnings 表示を追加。
- `docs/design/companion-mode.md` を current MVP 実装に合わせて更新。
- 検証:
  - `npx tsc -p tsconfig.electron.json --noEmit`
  - `npx tsx --test scripts/tests/companion-review-service.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts`

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion sibling check | `f640911` | merge 後に sibling path overlap warning を返す |
