# 目的

- Character Update Workspace の instruction に、`character.md` が何のための定義かを明示し、agent が更新対象の役割を誤解しない状態にする

# スコープ

- `src-electron/character-update-instructions.ts`
- `scripts/tests/character-update-instructions.test.ts`
- 関連 design doc

# 進め方

1. instruction に `character.md` の用途説明を追加する
2. test を更新する
3. design doc を current に合わせる
