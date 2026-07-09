# V2 session read adapter 実装サマリ

- slice: V2 runtime read-path / session read adapter
- mode: green
- 実装: `src-electron/session-storage-v2-read.ts`
- API:
  - `constructor(dbPath: string)`
  - `listSessionSummaries()`
  - `getSession(sessionId)`
  - `close()`
- summary は `sessions` 単体読み取り、detail は対象 session の messages / artifacts だけを読む。
