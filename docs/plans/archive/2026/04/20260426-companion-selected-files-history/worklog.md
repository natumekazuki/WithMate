# Companion Selected Files History 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。
- CompanionSession / Summary に `selectedPaths` を追加。
- `companion_sessions.selected_paths_json` を追加し、既存 DB には `ALTER TABLE` で default `[]` を入れるようにした。
- selected files merge 完了時に normalized selected paths を保存するようにした。
- Home の terminal CompanionSession history card に selected files summary を表示するようにした。
- `docs/design/companion-mode.md` と `docs/design/database-schema.md` を current 実装に合わせて更新。
- 検証:
  - `npx tsc -p tsconfig.electron.json --noEmit`
  - `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-review-service.test.ts scripts/tests/companion-session-service.test.ts`
  - `npm run build`
  - `npm test`

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion selected files history | `47204c8` | merge 済み履歴カードに selected files summary を表示する |
