# Character Management UI

> Status: Superseded

この文書が説明していた 3.x / 4.0.0 の Character 管理 UI と `character-update` Session は現行設計ではない。

現行の Character Editor と Character authoring workflow は次を参照する。

- `src/CharacterEditorApp.tsx`
- `scripts/tests/character-editor-app.test.tsx`
- `docs/adr/010-character-authoring-project-contract.md`
- `docs/design/character-authoring-growth.md`

Character 改善は `character-authoring` Session を Character directory で開き、通常 composer の自然言語指示と app 管理の固定 Skill を使う。専用の update Session variant や Memory Extract UI は持たない。
