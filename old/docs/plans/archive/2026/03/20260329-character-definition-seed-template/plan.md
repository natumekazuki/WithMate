# 目的

- 新規キャラクター作成時に `character.md` へ最小テンプレートを seed して、名前だけ Save した直後から update agent が作業しやすい状態にする

# スコープ

- `src-electron/character-update-instructions.ts`
- `src-electron/character-storage.ts`
- `scripts/tests/character-update-instructions.test.ts`
- 関連 design doc

# 進め方

1. `character-definition-format` に沿った最小テンプレートを定義する
2. 新規保存時だけ `character.md` seed を適用する
3. test と docs を更新して検証する
