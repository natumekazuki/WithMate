# 目的

- `character-prompt-maker` を参考に、WithMate 向けの `character.md` 標準構成を見直す
- `character.png` を Character Update workflow の正式対象として skill / template / design に反映する

# スコープ

- `src-electron/character-update-instructions.ts`
- `src-electron/character-storage.ts`
- 必要なら `src/CharacterUpdateApp.tsx`
- `docs/design/character-definition-format.md`
- `docs/design/character-storage.md`
- `docs/design/character-update-workspace.md`

# 進め方

1. `character-prompt-maker` の構成要素を WithMate 向けに取捨選択する
2. `character.md` seed template と skill を更新する
3. `character.png` を workflow の正式対象として docs と UI に反映する
4. build / 関連 test で確認する
