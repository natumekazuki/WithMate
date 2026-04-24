# Worklog

## 2026-04-24

- repo plan を作成した。
- 現行の `src-electron/snapshot-ignore.ts` と `src-electron/codex-adapter.ts` を確認した。
- `src-electron/snapshot-ignore.ts` に `WorkspaceSnapshotIndex` / `createWorkspaceSnapshotIndex()` / `refreshWorkspaceSnapshotIndex()` を追加した。
- `src-electron/codex-adapter.ts` を workspace roots ごとの snapshot index cache 経由に切り替えた。
- `scripts/tests/codex-adapter.test.ts` に targeted capture と incremental refresh の test を追加した。
- `docs/design/provider-adapter.md` に index refresh / full rebuild fallback 条件を反映した。
- `npx tsc -p tsconfig.electron.json --noEmit --pretty false` と `npm run build:electron` が成功した。
- `npx tsx --test scripts/tests/codex-adapter.test.ts` は sandbox の `spawn EPERM` で実行不可だった。
- `npm run typecheck` は既存の renderer / test 側型エラーで失敗した。
- result を完了状態に更新した。
- review 指摘を受け、`refreshWorkspaceSnapshotIndex()` の refresh 後 limit 判定を `>` から `>=` に変更した。
- file count limit 到達時に full rebuild へ戻る回帰 test を `scripts/tests/codex-adapter.test.ts` に追加した。
