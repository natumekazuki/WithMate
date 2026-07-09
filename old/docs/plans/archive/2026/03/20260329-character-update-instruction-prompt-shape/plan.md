# 目的

- Character Update Workspace の instruction に、`character.md` が prompt へどの形で入るかを明示し、agent が更新対象の出力形を誤解しない状態にする

# スコープ

- `src-electron/character-update-instructions.ts`
- `scripts/tests/character-update-instructions.test.ts`
- 関連 design doc

# 進め方

1. instruction に prompt での投入形を追記する
2. test を更新する
3. design doc を current に合わせる
