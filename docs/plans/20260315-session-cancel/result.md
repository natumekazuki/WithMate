# Result

- Session 実行中は composer の主操作が `Send` から `Cancel` に切り替わる。
- `Cancel` は Main Process の `AbortController` を通して Codex SDK 実行を中断する。
- キャンセル後の session は `runState = idle` に戻り、chat には `実行をキャンセルしたよ。` を追加する。
- Audit Log は 1 turn 1 record を維持したまま `CANCELED` に更新し、ユーザーキャンセルを error として残す。
- canceled / failed でも、途中まで取得できた response / operations / raw items / artifact を残す。
- 検証: `npm run typecheck`、`npm run build`
