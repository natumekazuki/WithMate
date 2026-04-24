# Workspace snapshot / diff pipeline 最適化 plan

- 作成日: 2026-04-24
- Plan tier: session plan
- 対象: `docs/optimization-roadmap.md` の `Workspace snapshot / diff pipeline`

## 目的

turn 実行後の workspace snapshot capture で、変更候補が明確な場合に after 側の全走査を避ける。副作用範囲が不明な turn は従来の全走査へ fallback し、artifact の変更検出を保つ。

## 方針

1. `src-electron/snapshot-ignore.ts` に候補ファイルだけを読み取る snapshot capture API を追加する。
2. `src-electron/codex-adapter.ts` で completed `file_change` のみから変更候補を作れる場合、after snapshot を候補ファイルに限定する。
3. command / MCP など副作用範囲が不明な operation がある場合は full snapshot fallback を維持する。
4. 対象 API の単体テストを追加し、既存の provider / codex 周辺 test と typecheck を実行する。

## 実施結果

- `src-electron/snapshot-ignore.ts` に `captureWorkspaceSnapshotPaths()` を追加した。
- targeted capture は候補ファイルだけを読み、候補ファイルの親ディレクトリに必要な `.gitignore` matcher だけを読み込む。
- `src-electron/codex-adapter.ts` は completed `file_change` だけで変更候補を確定でき、`command_execution` / `mcp_tool_call` が無い場合に after snapshot を targeted capture へ切り替える。
- 副作用範囲が不明な場合は full snapshot fallback を維持する。
- `docs/design/provider-adapter.md` に after snapshot の targeted capture / full fallback 条件を反映した。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit --pretty false`: 成功
- `npm run build:electron`: 成功
- `npx tsx --test scripts/tests/codex-adapter.test.ts`: `tsx` / Node test runner が内部 spawn で `EPERM` となるため、この sandbox では実行不可
- `npm test -- scripts/tests/codex-adapter.test.ts`: package script の glob と追加引数が合成され全 test 起動になり、同じく `spawn EPERM` で実行不可
- `npm run typecheck`: 既存 test / renderer 側の未解消型エラーが多数あり失敗。今回対象の Electron 側 typecheck は個別に成功

## Docs Sync 判定

- `docs/design/provider-adapter.md`: 更新済み。provider artifact の snapshot / diff 仕様が変わるため。
- `.ai_context/`: ディレクトリが存在しないため更新なし。
- `README.md`: 利用入口やセットアップ手順に変更がないため更新なし。

## チェックリスト

- [x] 現行 snapshot / artifact の責務確認
- [x] session plan 作成
- [x] 候補ファイル snapshot API 実装
- [x] Codex after snapshot の targeted fallback 実装
- [x] 単体テスト追加
- [x] build / test / docs 影響確認
- [x] plan archive
