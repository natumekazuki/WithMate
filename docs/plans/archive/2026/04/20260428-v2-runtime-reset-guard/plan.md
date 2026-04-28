# V2 runtime reset guard

## Status

完了

## 背景

`master...HEAD` の差分レビューで、V2 DB 選択後の全初期化と summary-only session の write path にデータ消失・起動不能リスクが見つかった。

## スコープ

- V2 DB の全初期化後も V2 schema が作られ、runtime が再初期化できるようにする。
- V2 の summary-only session が message payload を空で上書きしないようにする。
- 対象の回帰テストを追加する。

## スコープ外

- V2 migration の仕様変更。
- Audit Log / Session UI の追加最適化。
- Memory Management の追加 index / FTS。

## チェックポイント

- [x] V2 DB recreate の schema 初期化経路を修正する。
- [x] character 更新時の summary-only session 上書きを防ぐ。
- [x] 対象テストと `build:electron` を通す。
- [x] レビュー結果を反映する。
- [x] 完了後に plan を archive する。

## 結果

- V2 DB recreate 時に V2 schema を作成してから storage を初期化するようにした。
- summary-only session の保存時に既存 message / stream を補完し、空 payload で上書きしないようにした。
- character 更新時の対象 session 取得を full hydrate に寄せ、direct storage upsert に summary-only session が渡らないようにした。
- サブエージェントレビューで actionable finding なしを確認した。

## 検証

- `npx tsx --test scripts/tests/character-runtime-service.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts scripts/tests/session-persistence-service.test.ts`
- `npm run build:electron`
- `npm test`
