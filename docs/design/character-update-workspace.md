# Character Update Workspace

> Status: Superseded

この文書が提案していた `character-update` Session、専用 UI、`character-definition-update` Skill、Memory Extract、Character 保存時の instruction 同期は採用しない。

現行の Character 改善 workflow と判断理由は次を正本とする。

- `docs/adr/010-character-authoring-project-contract.md`
- `docs/design/character-authoring-growth.md`
- `resources/skills/withmate-character-authoring/SKILL.md`

Character 改善は `character-authoring` Session を Character directory で開き、通常 composer の自然言語指示と app 管理の固定 Skill を使う。現行の source と executable contract への pointer は ADR 010 を参照する。
