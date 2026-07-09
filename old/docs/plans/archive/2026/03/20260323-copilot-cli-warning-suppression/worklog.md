# Worklog

## 2026-03-23

- Copilot CLI の `stderr` warning による false error 調査用 plan を作成した
- `@github/copilot-sdk` が child CLI の `stderr` を含む exit を `code 0` でも失敗扱いすることを確認した
- `src-electron/copilot-adapter.ts` に Copilot child process 用 env helper を追加し、`NODE_NO_WARNINGS=1` を渡すようにした
- `scripts/tests/copilot-adapter.test.ts` を追加して warning 抑止 env の回帰テストを入れた
- `docs/design/`、`README.md`、`.ai_context/` は今回の internal workaround では公開仕様や導線に変更がないため更新不要と判断した
- `npm run typecheck`、`node --import tsx --test scripts/tests/copilot-adapter.test.ts`、`npm run build` を通した

## Commit

- `f6850da` `feat(copilot): add minimal provider integration`
  - Copilot child CLI の warning 抑止 env と回帰テストを同一コミットに含めた
