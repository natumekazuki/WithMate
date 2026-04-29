# 調査サマリ
- V1現状では `sessions`/`audit_logs` の JSON 集約と `listSessions`/`getSnapshot` のフル読み取りがデータロードの主要要因。
- V2 移行は `session_messages` と `audit_log_details` への分離が最優先。
- `database-schema-v2.ts` は現状 note レベルで、実DDLが未実装。
- 実装順としては `schema -> migration -> storage分割 -> ipc/preload -> renderer` が実害最小。
- 未確定点は `stream_json` の保持方針、V2での memory 系データ互換、JSON破損時のエラー運用。
