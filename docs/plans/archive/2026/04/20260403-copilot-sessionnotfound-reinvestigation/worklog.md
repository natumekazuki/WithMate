# Worklog

- 2026-04-03: plan 開始。`#40` は調査先行とし、原因仮説と修正案の合意後に実装へ進む。
- 2026-04-03: issue `#40` を確認。症状は「`threadId` は変わらず、agent 切り替え後は同じ session で通る。resume 未実行か自動 retry 不全ではないか」という内容だった。
- 2026-04-03: `src-electron/copilot-adapter.ts` と `src-electron/session-runtime-service.ts` を確認。cached `CopilotSession` の `SessionNotFound` は adapter 内 retry 対象だが、`operations` が 1 件でも partial に載ると retry を止める実装になっていた。
- 2026-04-03: `toCommandOperations()` が step の `status` を捨てて `summary/details` だけへ潰しているため、pending / in_progress の途中 step でも completed 済みの user-visible partial と同じ扱いになり、internal retry を過剰に止める可能性があると判断した。
- 2026-04-03: user と方針合意後、`src-electron/copilot-adapter.ts` の `toCommandOperations()` を terminal status 限定へ修正し、`scripts/tests/copilot-adapter.test.ts` に `tool.execution_start` だけでは retry を止めない回帰を追加した。
- 2026-04-03: `node --import tsx scripts/tests/copilot-adapter.test.ts` と `npm run build` で修正を確認した。
- 2026-04-03: コミット `090a1c8` `fix(copilot): stale session retry の partial 判定を絞る` を作成した。
