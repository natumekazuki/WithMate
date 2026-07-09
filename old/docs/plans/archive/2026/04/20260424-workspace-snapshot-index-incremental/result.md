# Result

- status: completed

## 変更内容

- `src-electron/snapshot-ignore.ts`
  - `WorkspaceSnapshotIndex` を追加した。
  - `createWorkspaceSnapshotIndex()` で full rebuild し、snapshot 本文・file metadata・directory mtime・ignore source 状態を cache するようにした。
  - `refreshWorkspaceSnapshotIndex()` で ignore / directory / limit を検証し、構造変化がなければ known file の mtime / size 差分だけを再読込するようにした。
  - completed `file_change` のように候補が信頼できる場合は、candidate path だけを refresh できるようにした。
- `src-electron/codex-adapter.ts`
  - workspace roots ごとの snapshot index cache を追加した。
  - turn 開始時の before snapshot と turn 終了時の after snapshot を index refresh 経由へ切り替えた。
  - `command_execution` / `mcp_tool_call` があっても、directory 構造と ignore source が変わらなければ full content scan ではなく incremental refresh するようにした。
- `scripts/tests/codex-adapter.test.ts`
  - targeted capture と index incremental refresh の test を追加した。
- `docs/design/provider-adapter.md`
  - snapshot / diff pipeline の現行仕様を index refresh 前提へ更新した。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit --pretty false`: 成功
- `npm run build:electron`: 成功
- `git diff --check`: 成功
- `npx tsc scripts/tests/codex-adapter.test.ts --ignoreConfig --outDir .tmp-test-run --module NodeNext --target ES2024 --moduleResolution NodeNext --types node,electron --skipLibCheck --esModuleInterop`: 成功
- `node .tmp-test-run\scripts\tests\codex-adapter.test.js`: 6 件成功
- `npx tsx --test scripts/tests/codex-adapter.test.ts`: sandbox 内で `spawn EPERM` により実行不可
- `npm run typecheck`: 既存の renderer / test 側型エラーにより失敗。今回対象の Electron 側 typecheck は個別に成功

## 残リスク

- directory mtime が変わる新規作成・削除は安全側で full rebuild へ戻す。既存 file の内容更新に対する全本文再読込削減を第一段とした。
- mtime / size が同一の内容変更は検知できない可能性がある。必要なら次段で content hash sampling または watcher invalidation を検討する。
- `tsx` test は sandbox 制約で未実行。

## コミット

- 未作成。
