# 作業記録

- 参照元 skill と current 実装の差分確認を開始
- `character-prompt-maker` のうち、既存ドラフト尊重、`character.md / character-notes.md` の役割分離、更新ルール、自己チェックを instruction へ反映
- `scripts/tests/character-update-instructions.test.ts` を current 文言へ更新
- `npm run build` と `node --test --import tsx scripts/tests/character-update-instructions.test.ts scripts/tests/character-update-workspace-service.test.ts` を通過
- `character.md` の用途説明は別 task へ切り出して追加する方針とした
- コミット: `668614f` `feat(character): improve update workspace definitions`
