# Worklog

- 2026-03-28: plan 作成
- 2026-03-28: Session domain の切り出し対象を棚卸しし、次の slice 候補として確定
- 2026-03-28: `src/session-state.ts` を追加し、`Session / Message / StreamEntry / buildNewSession / normalizeSession / URL helper` を `app-state.ts` から分離
- 2026-03-28: `src-electron/main.ts`、`src-electron/session-storage.ts`、`src-electron/session-persistence-service.ts`、`src/HomeApp.tsx`、`src/App.tsx`、`src/DiffApp.tsx` の import を新 module に寄せた
- 2026-03-28: character editor 用 URL helper の欠落を `src/character-state.ts` へ戻し、build を復旧
- 2026-03-28: `npm run build` と Session 周辺の unit test 11 本を通過
- 2026-03-28: `9330cce` `refactor(runtime): split session and observability state`
