# Plan

- 作成日: 2026-03-28
- タスク: Session Memory から Project Memory への昇格保存を実装する

## Goal

- `Session Memory` から durable knowledge を最小ルールで `Project Memory` に昇格できるようにする
- session memory extraction 完了後に project scope を解決して `project_memory_entries` へ保存する
- 昇格対象と非対象を current 実装として固定する

## Scope

- `src-electron/main.ts`
- `src-electron/project-memory-storage.ts`
- 必要な helper / test
- 関連 design doc / backlog / DB 定義書

## Out Of Scope

- retrieval 実装
- decay / ranking 実装
- renderer UI
- LLM を使った昇格判定

## Checks

1. session memory extraction 成功後に `Project Memory` 昇格が走る
2. `goal` と `nextActions` は昇格しない
3. 昇格対象のカテゴリと entry 形式が docs と一致する
4. tests と docs が current 実装へ同期している
