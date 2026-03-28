# Result

- 状態: 完了

## Summary

- 全機能の棚卸しとリファクタ優先順を整理する
- `Window / Session Runtime / Provider / Memory / Character / Settings / Persistence / UI Projection` の 8 ドメインに分けて current 実装を棚卸しした
- first slice は `SessionRuntimeService` による `turn 実行 / cancel / in-flight` の分離とし、`session 起動 / 再開` は follow-up slice に切り分けた

## Verification

- docs-only のため未実施

## Notes

- 実装前の整理タスク
- docs 精査はリファクタ後に行う前提を固定した
