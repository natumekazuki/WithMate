# V2 end-to-end verification

## Status

完了

## 背景

V2 schema / migration / runtime read-write は個別に整ってきたが、V1 実データ相当から V2 runtime 操作までの通し保証が弱い。

## スコープ

- V1 fixture DB を V2 へ migration し、runtime lifecycle で V2 として開けることを確認する。
- session summary / detail、audit summary / detail の読み出しを確認する。
- session 更新、audit 追加、character 更新、DB recreate の主要 write path を確認する。
- 必要に応じて既存テストヘルパーを小さく整理する。

## スコープ外

- migration UI の追加。
- 本番 DB 自動 migration。
- UI virtualization / connection lifecycle の最適化。

## チェックポイント

- [x] migration fixture と runtime lifecycle の既存テスト構造を把握する。
- [x] V1→V2→runtime の通しテストを追加する。
- [x] runtime write path の主要操作を通しテストに含める。
- [x] 対象テスト、`build:electron`、必要な全体テストを通す。
- [x] サブエージェントレビューを反映する。
- [x] 完了後に plan を archive する。

## 検証

- `npx tsx --test scripts/tests/database-v1-to-v2-migration.test.ts`
- `npm run build:electron`
- `npm test`

## 結果

- V1 fixture から V2 DB を作成し、runtime lifecycle で V2 として開く通しテストを追加した。
- session summary / detail、audit summary / detail、session 更新、audit 追加、character 更新、DB recreate 後の V2 write/read を検証した。
- audit summary では operation details を読まず、detail API では details を復元する lazy-load 境界を検証した。
- runtime update 後も message artifact が保持されることを検証した。
- サブエージェントレビューで指摘された項目は同 plan 内で反映し、再レビューで追加の correctness issue がないことを確認した。
