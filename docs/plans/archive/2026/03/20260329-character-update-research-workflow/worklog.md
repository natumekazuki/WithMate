# 作業記録

- current の `character-update-workspace.md`、`character-definition-format.md`、`provider-adapter.md` を確認
- 外部調査は hidden automation ではなく user-driven session workflow に寄せる前提で着手
- instruction に `必要なら web / wiki を参照し、根拠は character-notes.md に残す` ルールを追加
- コミット: `1a88b45` `docs(character): add research guidance to update instructions`
- `character-update-workspace.md` に `Natural Language Update Workflow` と `External Research Policy` を追加
- workspace 固定 workflow を `skills/character-definition-update/SKILL.md` として seed する方針に変更
- provider ごとの instruction file は fixed skill を前提にする薄い導入ルールへ寄せた
- `character-update-instructions.ts` に workspace skill seed と薄い instruction 構成を実装
- `character-storage.ts` と `character-update-workspace-service.ts` で skill file 同期を追加
- `CharacterUpdateApp.tsx` の Files 一覧に skill path を追加
- 検証:
  - `node --test --import tsx scripts/tests/character-update-instructions.test.ts scripts/tests/character-update-workspace-service.test.ts`
  - `npm run build`
- コミット: `cb335aa` `feat(character): seed update workflow skill`
