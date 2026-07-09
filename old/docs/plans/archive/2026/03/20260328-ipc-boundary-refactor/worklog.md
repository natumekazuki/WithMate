# 20260328 IPC Boundary Refactor Worklog

- 2026-03-28: task 開始。`preload.ts`、`withmate-window.ts`、`main-ipc-registration.ts` の責務棚卸しから着手。
- 2026-03-28: `withmate-window` を `withmate-ipc-channels.ts`、`withmate-window-types.ts`、`withmate-window-api.ts` に分割。`preload-api.ts` を追加して preload bridge を domain helper 化。
- 2026-03-28: `main-ipc-registration.ts` を window / catalog / settings / session query / session runtime / character の register group に整理。`scripts/tests/preload-api.test.ts` を追加し、`npm run build` と IPC 関連 test を通過。
- 2026-03-28: コミット `2a1282d` `refactor(ipc): split preload and registration boundaries`
