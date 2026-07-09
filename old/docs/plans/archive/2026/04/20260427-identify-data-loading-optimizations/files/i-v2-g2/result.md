# V2 session read adapter 結果

- phase: green
- slice id: `i-v2-g2`

## 実装要約

- `SessionStorageV2Read` を追加した。
- `constructor(dbPath)` で `openAppDatabase(dbPath)` を使用する。
- `listSessionSummaries()` は `sessions` table のみから header を読み、壊れた `allowed_additional_directories_json` は skip する。
- `getSession(sessionId)` は sessions header と `session_messages` を `seq` 昇順で読み、artifact row を復元する。
- session detail の `stream` は `[]` を固定で返す。

## 検証結果

- `npx tsx --test scripts/tests/session-storage-v2-read.test.ts scripts/tests/session-storage.test.ts`: pass
- `npm run build:electron`: pass
