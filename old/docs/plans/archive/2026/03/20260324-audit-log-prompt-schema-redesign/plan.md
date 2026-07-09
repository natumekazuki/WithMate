# Audit Log Prompt Schema Redesign Plan

## Goal

- audit log の prompt まわりを固定 3 カラム前提から外し、provider ごとの差を保持できる JSON ベース構造へ置き換える
- `logical prompt` と `transport payload` を分離し、Copilot の `systemMessage` 化に耐えられる形にする

## Scope

- `AuditLogEntry` の prompt 関連型を再設計する
- SQLite `audit_logs` に JSON 列を追加し、storage read/write を切り替える
- Session Window の Audit Log overlay を新構造に合わせて更新する
- provider runtime / adapter の返却値を新構造へ合わせる
- design doc / manual test / storage test を更新する

## Out of Scope

- Copilot `systemMessage` 実装本体
- audit log export
- 旧 row の完全移行

## Target Shape

- `logical_prompt_json`
  - `systemText`
  - `inputText`
  - `composedText`
- `transport_payload_json`
  - `summary`
  - `fields[]`
    - `label`
    - `value`

## Steps

1. shared type と storage schema を更新する
2. Codex / Copilot adapter の result に `transportPayload` を載せる
3. main process の audit write path を新型へ切り替える
4. Audit Log overlay を `Logical Prompt / Transport Payload` 表示へ更新する
5. docs / tests / build を更新する
