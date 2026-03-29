# Worklog

## 2026-03-29

- 現行 `src-electron/provider-prompt.ts` を確認し、`systemBodyText` には character が入る一方、`logicalPrompt.systemText` と `logicalPrompt.composedText` が prefix ベースのままであることを確認した
- `src-electron/codex-adapter.ts` が `thread.runStreamed()` に `prompt.logicalPrompt.composedText` を渡しているため、Codex 経路で character が欠落することを再確認した
- `f6850da` / `da89b88` / `b892f01` の `src-electron/provider-prompt.ts` を Git 履歴から確認し、旧挙動では composed prompt に character が含まれていたことを確認した
- 原因コミット候補を `0a8f4bd` と整理し、memory section 追加時の prompt 分離差分が回帰を生んだと判断した
- `docs/plans/20260329-codex-character-injection-restore/` を作成し、plan / decisions を記録した
- 外部 session plan を current task 向けに更新した
- `src-electron/provider-prompt.ts` で `logicalPrompt.systemText` を `systemBodyText` と同じ system-level prompt にそろえ、`logicalPrompt.composedText` もその値から再合成する最小修正を実装した
- `scripts/tests/provider-prompt.test.ts` を強化し、`logicalPrompt.systemText === systemBodyText`、`composedText === systemText + inputText` に加えて、`assertSectionOrder` で missing を見逃さない順序検証へ置き換えた
- 未コミット状態で `npx tsx --test scripts/tests/provider-prompt.test.ts` を実行し、対象テストが成功した
- `npm test` を実行し、成功した
- `npm run build` を実行し、成功した
- `npm exec -- tsc -p tsconfig.electron.json --noEmit --pretty false` を実行し、成功した
- `npm run typecheck` は既存 baseline failure により失敗したが、今回の変更ファイル `src-electron/provider-prompt.ts` / `scripts/tests/provider-prompt.test.ts` に新規起因はないことを確認した
- manual 実機確認は未実施で、必要なら Codex 実行時の実応答反映を次段で確認する
- docs-sync 判断として `docs/design` / `README.md` / `.ai_context` は更新不要と整理した
