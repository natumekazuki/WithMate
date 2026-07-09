# Worklog

- 2026-03-28: plan 作成
- 2026-03-28: commit `e82e917` `refactor(main): extract window and store lifecycle services`
- 2026-03-28: 次の hotspot を `main.ts` の broadcast helper 群に設定
- 2026-03-28: `src-electron/window-broadcast-service.ts` を追加し、window 向け broadcast helper を `main.ts` から分離
- 2026-03-28: `SessionObservabilityService` の callback も `WindowBroadcastService` 経由へ統一
- 2026-03-28: `src/time-state.ts` を追加し、`app-state.ts` に残っていた日時 helper を分離
- 2026-03-28: `npm run build` と broadcast 周辺の unit test を通過
