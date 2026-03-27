# Plan

- 作成日: 2026-03-28
- タスク: memory の時間減衰を retrieval / ranking に入れる

## Goal

- `Project Memory` と `Character Memory` の retrieval に時間減衰を加える
- 古い記憶の価値を下げつつ、完全に消えない ranking を実装する
- current の lexical retrieval に最小差分で組み込む

## Scope

- `src-electron/project-memory-retrieval.ts`
- `src-electron/character-memory-retrieval.ts`
- 関連 tests
- 関連 design docs / backlog / DB 定義書

## Out Of Scope

- vector retrieval
- 永続 schema の追加
- UI での score 表示

## Checks

1. 古い entry より最近使われた entry が優先される
2. relevance が十分高い場合は古い entry も残れる
3. `Project Memory` と `Character Memory` の両方で同じ考え方を使う
