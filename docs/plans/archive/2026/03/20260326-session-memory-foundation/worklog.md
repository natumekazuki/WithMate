# Worklog

- 2026-03-26: plan 作成。既存コードには memory 保存層が存在せず、`Session Memory` の shared type と SQLite table を最初に足すのが最小 slice と判断した。
- 2026-03-26: `src/app-state.ts` に `SessionMemory` / `SessionMemoryDelta` / normalize / merge helper を追加した。
- 2026-03-26: `src-electron/session-memory-storage.ts` を追加し、`session_memories` table と foreign key cascade を実装した。
- 2026-03-26: `src-electron/main.ts` で session create / update / run 後の memory metadata 同期を追加した。
- 2026-03-26: `scripts/tests/session-memory-storage.test.ts` を追加し、`SessionStorage` 既存 test と build も再実行した。
