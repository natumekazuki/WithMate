# result

## status

- 完了

## summary

- `CopilotAdapter` の cached session reuse 中に発生する `SessionNotFound` が internal retry 条件から漏れていたため、connection retry と同列に recovery するよう修正した
- retry を止める partial 判定は `assistantText` / operations / `artifact.changedFiles` など user-visible partial に限定し、`session.error` 由来の `rawItems` だけでは止めないようにした
- `scripts/tests/copilot-adapter.test.ts` に missing session retry の回帰を追加し、`npm run build` と `node --import tsx scripts/tests/copilot-adapter.test.ts` を通した
- `docs/design/provider-adapter.md` を同期した
- `.ai_context/` と `README.md` は今回の bugfix では更新不要と判断した
- 実装 commit は `b15a4e9` `fix(copilot): retry stale cached sessions`
