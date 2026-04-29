# 設計ノート: app database path 決定ヘルパー (Red phase)

## スコープ

- テスト対象: `resolveAppDatabasePath(userDataPath: string): string`
- 追加先: `scripts/tests/app-database-path.test.ts` のみ
- 実装対象ファイルは変更しない（Red phase）

## 期待仕様

- `userDataPath` 配下の
  - `withmate-v2.db` が存在する場合は `withmate-v2.db` を返す
  - `withmate-v2.db` が存在せず、`withmate.db` がある場合は `withmate.db` を返す
  - `withmate-v2.db` / `withmate.db` の両方が存在する場合は `withmate-v2.db` を優先
  - 両方存在しない場合は `withmate.db` を返す（初回起動時の V1 fallback）
- どちらの DB も存在しない場合、関数実行時点で新規 DB を作成しない（startup migration を呼び出していないことを担保）

## テスト方針

- `node:fs/promises` で `withmate-v2.db`、`withmate.db` の有無を temp ディレクトリに準備し、期待値比較
- 既存の名前定数を利用して文字列の固定化を避ける
  - `APP_DATABASE_V1_FILENAME`
  - `APP_DATABASE_V2_FILENAME`
- 本体実装が未作成であることを前提に、テスト単体で失敗する
