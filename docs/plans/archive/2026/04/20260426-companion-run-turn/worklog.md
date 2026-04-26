# Companion run turn 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。直近コミットは `2e959f7`。
- 既存 SessionRuntimeService と provider runtime の境界を確認し、Companion は専用 runtime service から provider runtime を呼ぶ方針にした。
- `companion_sessions` に `run_state` / `thread_id` / `character_role_markdown` を追加し、`companion_messages` で会話履歴を保持するようにした。
- `CompanionRuntimeService` を追加し、CompanionSession を一時的な provider runtime 用 Session 形状へ変換して実行するようにした。
- provider 実行には `executionWorkspacePath` として `CompanionSession.worktreePath` を渡す。
- `getCompanionSession` / `runCompanionSessionTurn` / `cancelCompanionSessionRun` の IPC、preload、renderer API を追加した。
- `docs-sync`: repo-sync-required。Companion の provider 実行導線と永続化範囲が現行仕様に入ったため `docs/design/companion-mode.md` を更新した。`.ai_context/` は存在しないため更新なし。README は入口や公開導線の変更ではないため更新なし。
- 検証:
  - `npx tsc -p tsconfig.electron.json --noEmit`
  - `npx tsx --test scripts/tests/companion-runtime-service.test.ts scripts/tests/companion-storage.test.ts scripts/tests/companion-session-service.test.ts scripts/tests/home-launch-state.test.ts scripts/tests/preload-api.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-ipc-registration.test.ts`

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion run turn | `b307eb7` | CompanionSession から shadow worktree 上で provider 実行できるようにする |
