# Result

- prompt text から `Session Context` を削除した
- prompt text から `Referenced Paths` を削除した
- `systemPromptText` は `System Prompt Prefix + character.md` の空行結合になった
- `inputPromptText` はユーザー入力本文だけになった
- `composedPromptText` は text payload のみを表し、画像添付時の structured input 全体は含まない仕様を docs に明記した
- 検証: `npm run typecheck` / `npm run build`
