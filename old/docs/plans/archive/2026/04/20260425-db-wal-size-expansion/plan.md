# db-wal size expansion

- 作成日: 2026-04-25
- 種別: repo plan
- status: 完了

## Goal

`withmate.db-wal` がアプリ終了まで肥大化し続ける問題を抑制する。

## Scope

- SQLite connection の WAL 設定を共通化する
- app 終了時と DB 再生成前に WAL truncate checkpoint を実行する
- WAL maintenance の設計 docs とテストを更新する

## Checkpoints

- [x] 現状の SQLite connection と lifecycle を確認する
- [x] WAL 設定を `src-electron/sqlite-connection.ts` に集約する
- [x] `PersistentStoreLifecycleService` の close / recreate で WAL truncate checkpoint を実行する
- [x] テストと design doc を更新する
- [x] 検証コマンドを実行する
