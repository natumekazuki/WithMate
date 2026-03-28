# 20260329 WithMate Window API Surface Review Worklog

- 2026-03-29: task 開始。`withmate-window-api` と関連 module の public surface を棚卸し。
- 2026-03-29: `WithMateWindowApi` を navigation / catalog / session / observability / settings / character / picker / subscription の domain interface に分割。
- 2026-03-29: `preload-api.ts` の helper 返り値型を domain interface ベースに整理。build と preload/renderer test を通過。
- 2026-03-29: `8107e06` `refactor(ipc): split withmate window api domains`
  - `WithMateWindowApi` を domain interface に分割
  - `preload-api.ts` の helper 返り値型も domain 単位へ整理
