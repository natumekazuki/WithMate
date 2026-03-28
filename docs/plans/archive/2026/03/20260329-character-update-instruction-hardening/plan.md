# 目的

- `character-prompt-maker` を参照して、`AGENTS.md` と `copilot-instructions.md` の内容を current の Character Update Workspace に合う形へ強化する

# スコープ

- `src-electron/character-update-instructions.ts`
- `scripts/tests/character-update-instructions.test.ts`
- 関連 design doc

# 進め方

1. 参照元 skill と current 実装の差分を整理する
2. WithMate に持ち込むべき instruction を実装する
3. test と design doc を更新して検証する
