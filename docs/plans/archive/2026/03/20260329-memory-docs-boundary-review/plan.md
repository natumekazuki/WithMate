# 20260329 Memory Docs Boundary Review

## 目的

- `memory-architecture.md`、`project-memory-storage.md`、`character-memory-storage.md`、`prompt-composition.md` の current / supporting 境界を latest 実装に合わせて整理する
- memory 全体方針、個別 storage detail、coding plane prompt detail の責務重複を減らす
- `documentation-map.md` の分類を current 状態に合わせる

## スコープ

- `docs/design/memory-architecture.md`
- `docs/design/project-memory-storage.md`
- `docs/design/character-memory-storage.md`
- `docs/design/prompt-composition.md`
- 必要なら `docs/design/documentation-map.md`

## 非スコープ

- 実装コードの変更
- memory 仕様そのものの追加

## 完了条件

1. memory 系 current docs の責務境界が明確になっている
2. 同じ説明が複数文書に重複している箇所が整理されている
3. `documentation-map.md` の分類が latest 状態に一致している
