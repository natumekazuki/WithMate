# 結果

- 状態: 完了

## 実装

- `character.md` の標準構成を `character-prompt-maker` ベースで見直し、`Assets` と `./character.png` を正式な対象にした
- character 保存時に `character.md` / `character-notes.md` / `AGENTS.md` / `copilot-instructions.md` / workflow skill を seed する current 仕様へ揃えた
- `character-update` は専用 window ではなく `SessionWindow` variant として扱い、Character Editor から provider picker modal で直接起動する形へ整理した
- Character Editor に `character-notes.md` editor、`Reload`、`Open Folder` を追加し、header / footer の action 配置も current に合わせた
- 対応コミット: `ea4298b` `feat(character): streamline update session workflow`

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/character-update-instructions.test.ts scripts/tests/character-update-workspace-service.test.ts scripts/tests/character-runtime-service.test.ts`
