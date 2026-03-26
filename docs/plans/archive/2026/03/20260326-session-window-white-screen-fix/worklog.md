# Worklog

- 2026-03-26: plan 作成。user 報告では session DB と audit log を消しても Session Window が白画面のままなので、保存データより起動経路の例外を優先調査する。
- 2026-03-26: `ELECTRON_ENABLE_LOGGING=1` で起動し、`dist/assets/session-*.js` の `Uncaught ReferenceError: Cannot access 'A' before initialization` を確認した。
- 2026-03-26: `src/App.tsx` を確認し、`retryBanner` の `useMemo` が後方定義の `pendingIndicatorCharacterName` を参照していることを特定した。
- 2026-03-26: `pendingIndicatorCharacterName` と live run 派生値を `retryBanner` より前へ移動して TDZ を解消した。
- 2026-03-26: `npm run build` と `ELECTRON_ENABLE_LOGGING=1 npm run electron:start` で renderer 例外が消えたことを確認した。
