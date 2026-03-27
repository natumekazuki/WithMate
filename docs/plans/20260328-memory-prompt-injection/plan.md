# Plan

- 作成日: 2026-03-28
- タスク: Session Memory と Project Memory を coding plane prompt に注入する

## Goal

- `Session Memory` を毎 turn の prompt に常設する
- `Project Memory` を user message 起点の keyword retrieval で最大 3 件まで注入する
- `System Prompt -> Character -> Session Memory -> Project Memory -> User Input` の順を current 実装にする

## Scope

- `src-electron/provider-prompt.ts`
- `src-electron/project-memory-retrieval.ts`
- `src-electron/main.ts`
- 必要な shared type / test
- 関連 design doc / DB 定義書

## Out Of Scope

- vector search
- FTS5
- decay / ranking
- Character Memory の prompt 注入

## Checks

1. `Session Memory` section が毎 turn の prompt に入る
2. `Project Memory` section は retrieval hit がある時だけ入る
3. `Project Memory` retrieval は最大 3 件で、category label を保持する
4. tests と docs が current 実装へ同期している
