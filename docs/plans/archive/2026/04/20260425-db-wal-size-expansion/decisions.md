# decisions

## 2026-04-25

- WAL は無効化せず、`journal_mode = WAL` を維持する。
- 全 SQLite connection に `wal_autocheckpoint = 256`、`journal_size_limit = 67108864`、`busy_timeout = 5000` を適用する。
- app 起動中は 5 分ごとに WAL size を確認し、64 MiB を超えていれば `wal_checkpoint(TRUNCATE)` を実行する。
- app 終了時と DB 再生成前にも `wal_checkpoint(TRUNCATE)` を実行し、長期起動後の WAL ファイルを縮小する。
