# Worklog

- 2026-03-28: plan を開始。`Session Memory` 常設と `Project Memory` keyword retrieval を coding plane prompt へ接続する。
- 2026-03-28: lexical retrieval と prompt injection を実装した。
  - `src-electron/project-memory-retrieval.ts` を追加
  - `src-electron/provider-prompt.ts` で `# Session Memory` / `# Project Memory` section を合成
  - `src-electron/main.ts` で session memory 読み出しと project memory retrieval を provider 入力へ接続
  - docs と backlog を current 実装へ同期
- 2026-03-28: `0a8f4bd feat(memory): promote and inject project memory`
  - `Session Memory` の常設注入と `Project Memory` の lexical retrieval 注入を commit
