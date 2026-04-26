# Companion Review Window 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。直近コミットは `96cdb1b`。
- `provider-artifact` の diff row / summary 生成を Review Window 用 service から再利用できるように export した。
- `CompanionReviewService` を追加し、base snapshot commit と shadow worktree の tracked / untracked 差分から changed files を作るようにした。
- Review Window 用 IPC / preload API / aux window / Vite entry / renderer UI を追加した。
- Home の active CompanionSession card から Review Window を開けるようにした。
- `docs/design/companion-mode.md` を更新し、Current MVP 実装の Review Window 表示範囲を反映した。
- `.ai_context/` はこの worktree に存在しないため、追加同期は不要。
- 検証: `npx tsx --test scripts/tests/companion-review-service.test.ts scripts/tests/aux-window-service.test.ts scripts/tests/window-entry-loader.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts` は pass。
- 検証: `npm test` は pass。
- 検証: `npm run build` は pass。

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion Review Window | `c572fc6` | CompanionSession の changed files と diff を Review Window に表示する |
