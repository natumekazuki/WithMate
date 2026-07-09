# Design Note

- 対象挙動
  - V2 DB では `SessionStorage` / `AuditLogStorage` の write-capable 実装を起動時に使わない。
  - V2 DB では `SessionStorageV2Read` の要約読込経路、および `AuditLogStorageV2Read` の読込経路を使う。
- red で採用した検証原則
  - 実際の V2 スキーマを使って V1 reader の `listSessions` を起点に失敗することを検知。
  - V2 起動時に V1 factory の呼び出し回数を観測し、0 を期待。
- 変更境界
  - 現在はテストのみ変更。プロダクションコード変更は未実施（green フェーズで反映）。
