# Result

- 状態: 完了
- Add Character / Character 更新時に character ディレクトリへ `AGENTS.md` と `copilot-instructions.md` を同期するようにした
- update workspace 起動前でも、character 保存直後から agent 用 instruction file が揃う状態にした
- 検証:
  - `npm run build`
  - `node --test --import tsx scripts/tests/character-update-instructions.test.ts scripts/tests/character-runtime-service.test.ts`
- 対応コミット:
  - `b21ddc4` `feat(character): seed update instructions on save`
