# Worklog

## 2026-04-26

- `@` プレフィックス添付候補でディレクトリも選べるようにする作業を開始した。
- `src-electron/workspace-file-search.ts` に file / folder kind 付き候補 API を追加した。
- `src/App.tsx`、`src/session-components.tsx`、`src/styles.css` で候補表示に kind label と色分けを追加した。
- `scripts/tests/workspace-file-search.test.ts` に directory 候補と `.gitignore` 除外の回帰テストを追加した。
- `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` を更新した。
- `npm run build:electron` は成功した。
- `node --import tsx scripts/tests/workspace-file-search.test.ts` と `npm run build:renderer` は sandbox の `spawn EPERM` で実行不可だった。
- `npm run typecheck` は既存の repo-wide 型エラーで失敗した。今回差分由来の `scripts/tests/main-query-service.test.ts` mock 型は修正済み。
