# 目的

- `character.md` の見出し階層を prompt 合成の `# Character` section と整合する形に揃える

# スコープ

- `src-electron/character-update-instructions.ts`
- `scripts/tests/character-update-instructions.test.ts`
- `docs/design/character-definition-format.md`
- `docs/design/prompt-composition.md`

# 進め方

1. seed テンプレートの先頭見出しを見直す
2. format doc と prompt doc を current 仕様へ揃える
3. test と build を確認する
