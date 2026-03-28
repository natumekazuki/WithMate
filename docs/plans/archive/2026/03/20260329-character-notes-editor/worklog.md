# Worklog

- 開始: Character Editor へ `character-notes.md` 編集を追加する
- 実装: `CharacterProfile` / storage に `notesMarkdown` を追加し、character 保存時に `character-notes.md` を seed / 更新できるようにした
- 実装: Character Editor を `Profile / システムプロンプト / character-notes / Session Copy` の 4 タブ構成へ更新した
- 実装: Character Update Workspace の file list と instruction file を `character-notes.md` 前提に更新した
- 検証: `npm run build`
- 検証: `node --test --import tsx scripts/tests/character-update-instructions.test.ts scripts/tests/character-update-workspace-service.test.ts scripts/tests/character-runtime-service.test.ts`
- コミット: `37fb8ec` `feat(character): add notes editing workflow`
