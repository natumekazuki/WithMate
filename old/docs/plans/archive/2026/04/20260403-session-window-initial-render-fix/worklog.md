# Worklog

- 2026-04-03: plan 開始。`#39` を最優先で調査し、Session Window 初期表示で error fallback に落ちる原因を特定する。
- 2026-04-03: 再現 commit `265417742fa1a78ef5b8d53d38c2f3c590fe5bc0` を確認し、`src/App.tsx` の `auditLogRefreshSignature` が後方定義の `displayedMessages` を参照して TDZ 例外を起こすことを特定した。
- 2026-04-03: `auditLogRefreshSignature` を `selectedSession?.messages.length ?? 0` 参照へ修正し、`scripts/tests/session-app-render.test.ts` を追加して desktop runtime の初回 render 回帰を固定した。
- 2026-04-03: `node --import tsx scripts/tests/session-app-render.test.ts`、`node --import tsx scripts/tests/audit-log-refresh.test.ts`、`npm run build` で修正を確認した。
- 2026-04-03: コミット `9506609` `fix(session): Session Window 初期表示の TDZ 例外を防ぐ` を作成した。
