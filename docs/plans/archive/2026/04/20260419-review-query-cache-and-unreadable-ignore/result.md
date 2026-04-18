# Result

- status: done

## Summary

- `workspaceQueryCache` を workspace ごとの件数上限つき recent cache にし、古い query entry を排出するようにした。
- ignore ファイル読み取り失敗を `unreadable` と `race` に分離し、stable unreadable は毎 TTL で再走査せず、一定間隔ごとに再評価するようにした。
- `scripts/tests/workspace-file-search.test.ts` に review-0553 回帰テストを 2 件追加した。

## Validation

- `node --import tsx scripts/tests/workspace-file-search.test.ts`: **19/19 PASS**
- `npm run build`: **success**
- `npm run typecheck`: **fail（既知の repo-wide 問題）**

## Notes

- typecheck の代表エラーは `scripts/tests/app-settings-storage.test.ts` ほか今回差分外に集中しており、今回変更の `src-electron/workspace-file-search.ts` / `src-electron/snapshot-ignore.ts` / `scripts/tests/workspace-file-search.test.ts` 起因ではない。
- `docs/design/`・`.ai_context/`・`README.md` は更新不要と判断した。
