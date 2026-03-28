# 20260328 Main IPC Deps Domain Split Worklog

- 2026-03-28: task 開始。`main-ipc-deps.ts` と `main-bootstrap-deps.ts` の引数構造を domain 単位に再整理する。
- 2026-03-28: `createMainIpcRegistrationDeps()` の入力を `window / catalog / settings / sessionQuery / sessionRuntime / character` に grouped 化。`createMainBootstrapDeps()` と `main.ts` の wiring も同じ grouping へ更新。
- 2026-03-28: `scripts/tests/main-bootstrap-deps.test.ts` と `scripts/tests/main-ipc-deps.test.ts` を grouped input 前提に更新。`npm run build` と IPC 関連 test を通過。
- 2026-03-28: renderer / electron の import も `withmate-window` public entry 一本依存から `withmate-window-types` / `withmate-window-api` / `withmate-ipc-channels` へ段階的に寄せた。
- 2026-03-28: コミット `2a1282d` `refactor(ipc): split preload and registration boundaries`
