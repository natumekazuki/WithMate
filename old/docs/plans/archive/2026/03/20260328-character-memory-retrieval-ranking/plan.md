# Plan

- 作成日: 2026-03-28
- タスク: Character Memory retrieval / ranking を強化する

## Goal

- `Character Memory` を recent 順ではなく query-based に選別する
- monologue / reflection 向けに recent conversation 起点の lexical retrieval を実装する
- weak hit を落としつつ、hit が無い時は recent fallback を返す

## Scope

- `src-electron/character-memory-retrieval.ts`
- `src-electron/main.ts`
- 関連 tests
- 関連 design docs / backlog / DB 定義書

## Out Of Scope

- FTS / vector retrieval
- 時間減衰の本実装
- Character Memory 専用 UI

## Checks

1. recent conversation から relevant な Character Memory entry を選べる
2. weak hit は threshold で落ちる
3. hit が無い時は recent fallback を返せる
