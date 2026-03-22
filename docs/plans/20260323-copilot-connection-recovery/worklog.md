# Worklog

## 2026-03-23

- Copilot stale connection recovery 用 plan を作成した
- `Connection is closed.` と `CLI server exited ... code 0` を stale connection 系 message として recovery 対象にした
- `src-electron/copilot-adapter.ts` で partial result が空の stale connection だけ、cached session / client を捨てて 1 回だけ retry するようにした
- `scripts/tests/copilot-adapter.test.ts` に stale connection 判定と retry 条件の回帰テストを追加した
- `docs/design/`、`README.md`、`.ai_context/` は今回の internal runtime fix では公開仕様や導線に変更がないため更新不要と判断した
- `npm run typecheck`、`node --import tsx --test scripts/tests/copilot-adapter.test.ts`、`npm run build` を通した

## Commit

- なし
