# Worklog

- 2026-03-28: plan を開始。`openSessionWindow()` の registry / close policy / background hook を `Session Window bridge` に切り出す。
- 2026-03-28: `src-electron/session-window-bridge.ts` を追加。window registry、既存 window 再利用、running 中 close の確認、`session-start` / `session-window-close` hook を bridge に移した。
- 2026-03-28: `scripts/tests/session-window-bridge.test.ts` を追加。新規 open、既存 window 再利用、running close policy、idle close hook を固定した。
- 2026-03-28: `d44f2fa` `refactor(session): extract runtime and persistence services`
  - `SessionWindowBridge` の追加と `openSessionWindow()` の bridge 経由化をコミットした。
