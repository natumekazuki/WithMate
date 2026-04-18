# Result

- status: complete

## Summary

- active repo plan を初期化し、session summary を Home 系 window へ寄せ、Session window は軽量通知で detail を再取得する方針を明文化した
- チェックポイントとして、イベント契約整理、main 側 broadcast 分離、renderer 側購読分離、関連テスト更新、`docs/design/` 更新要否判断、最終レビューを設定した
- 局所リファクタは `WindowBroadcastService` / `AuxWindowService` 周辺の window 種別整理と payload 型 / subscription helper 整理までを同一 plan に含める
- renderer 全体の状態管理再設計とイベント基盤の全面刷新は follow-up 候補として分離する
- 実装では summary broadcast を Home 系 window のみに絞り、Session window には `withmate:sessions-invalidated` (`sessionId[]`) を配信する契約へ更新した
- `src/App.tsx` は `listSessionSummaries()` / `subscribeSessionSummaries()` 依存を外し、初回 `getSession(selectedId)` と invalidation 受信時の再 hydrate に整理した
- `scripts/tests/` と `docs/design/electron-session-store.md` を新契約へ更新した
- 自己レビューの結果、blocking issue は確認されなかった（`npx tsx --test scripts/tests/window-broadcast-service.test.ts scripts/tests/main-broadcast-facade.test.ts scripts/tests/preload-api.test.ts scripts/tests/session-persistence-service.test.ts scripts/tests/character-runtime-service.test.ts scripts/tests/settings-catalog-service.test.ts` で関連テスト通過）
- 検証では `npm test` が 339 テスト全件パスで成功し、task-local な型エラーも targeted typecheck で解消済みとなった
- repo-wide `npm run typecheck` failure は既存/別件由来の scope 外事項として切り分け済みであり、本 task は完了とする

## Open Items

- この task の未解決事項はなし
- repo-wide `npm run typecheck` failures は scope 外 follow-up として別途追跡する

## Validation Plan

- broadcast 配信先と payload 種別が用途別に分離されること
- Session window が軽量通知経由で detail を再取得できること
- 関連テストが契約変更を説明できること

## Archive Check

- 未解決事項: なし（repo-wide typecheck failures は scope 外 follow-up）
- docs 更新判断: 更新済み（`docs/design/electron-session-store.md`）
- 完了条件: 達成
