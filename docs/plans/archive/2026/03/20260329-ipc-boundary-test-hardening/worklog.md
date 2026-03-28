# 20260329 IPC Boundary Test Hardening Worklog

- 2026-03-29: task 開始。`preload-api`、`main-ipc-registration`、`withmate-window-api` の current test coverage を棚卸し。
- 2026-03-29: `preload-api.test.ts` に public API key 一覧と telemetry/background payload unwrap の regression test を追加。
- 2026-03-29: `main-ipc-registration.test.ts` に current invoke channel 一覧の registration test を追加。
- 2026-03-29: `a5fb3e1` `test(ipc): harden preload and registration boundaries`
  - `preload-api` の public shape / telemetry unwrap test を追加
  - `main-ipc-registration` の invoke channel registration test を追加
