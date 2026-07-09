# Worklog

- 2026-04-04: 正式リリース前の暫定機能棚卸しを開始。
- 2026-04-04: `README.md`、`docs/task-backlog.md`、`docs/manual-test-checklist.md`、`docs/design/monologue-provider-policy.md`、`docs/design/coding-agent-capability-matrix.md`、`src/settings-ui.ts`、`src/home-components.tsx` を確認し、pre-release 前提の文言と follow-up 前提の UI copy を抽出した。
- 2026-04-04: item 1 として、`README.md`、`src/settings-ui.ts`、`src/home-components.tsx`、`docs/manual-test-checklist.md`、`docs/design/settings-ui.md`、`docs/design/desktop-ui.md`、`docs/design/product-direction.md`、`docs/design/provider-adapter.md` から `初回リリース前` 互換性 note を削除し、`DB を初期化できる` という事実だけへ整理した。
- 2026-04-04: `npm run build` を実行し、互換性 note 削除後も build が通ることを確認した。
- 2026-04-04: item 2 として、`src/settings-ui.ts`、`src/home-components.tsx`、`README.md`、`docs/manual-test-checklist.md`、`docs/design/settings-ui.md`、`docs/design/desktop-ui.md` から user-facing な `future scope` / `current milestone` note を削除した。
- 2026-04-04: `npm run build` と検索確認により、公開面の `Character Stream 用 API` / `future note` 案内が残っていないことを確認した。
- 2026-04-04: item 3 として、`src/home-components.tsx` の `Memory 管理` 補助文から `follow-up task` 参照を削除し、`docs/design/memory-architecture.md` を current UI に合わせて同期した。
- 2026-04-04: `npm run build` と検索確認により、公開面の `manual update` / `follow-up task` 案内が残っていないことを確認した。
- 2026-04-04: 追加整理として、`src/home-components.tsx` / `src/HomeApp.tsx` / `src/settings-ui.ts` から Settings の説明文を削除し、`Coding Agent Credentials` / `Danger Zone` / Settings からの `Memory 管理` 導線を UI から外した。
- 2026-04-04: `README.md`、`docs/design/settings-ui.md`、`docs/design/desktop-ui.md`、`docs/design/window-architecture.md`、`docs/design/product-direction.md`、`docs/design/provider-adapter.md`、`docs/design/memory-architecture.md`、`docs/manual-test-checklist.md` を current UI に同期した。
- 2026-04-04: `npm run build` を実行し、Settings 整理後も build が通ることを確認した。
- 2026-04-04: コミット `7b32fec` `fix(settings): 正式リリース向けに設定UIを整理する` を作成した。
- 2026-04-04: `package.json` / `package-lock.json` の version を `1.0.0` に戻し、`src/home-components.tsx` の Memory 管理補助文を削除した。
- 2026-04-04: `npm run build` を実行し、version 変更後も build が通ることを確認した。
- 2026-04-04: コミット `ccae920` `fix(release): v1.0.0 へ整える` を作成した。
