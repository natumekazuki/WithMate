# 作業記録

- `character.md` の見出し階層調整を開始
- `buildCharacterMarkdownTemplate()` から `# {character_name}` 見出しを削除し、`## Character Overview` 始まりへ変更
- `## System Prompt` section を seed テンプレートから削除し、`character.md` 全体を prompt 定義として扱う current 仕様へ揃えた
- `character-definition-format.md` と `prompt-composition.md` を current 仕様へ更新
- `npm run build` と `node --test --import tsx scripts/tests/character-update-instructions.test.ts` を通過
- `character.md` の用途説明は instruction 側で明示する別 task へ分離した
- コミット: `668614f` `feat(character): improve update workspace definitions`
