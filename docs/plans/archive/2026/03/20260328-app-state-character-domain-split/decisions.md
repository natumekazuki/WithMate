# Decisions

- `app-state.ts` の次の split は character shared state を優先する
- `CharacterProfile`、theme、session copy、normalize helper、clone helper は `src/character-state.ts` を正本にする
- `app-state.ts` は `Session` domain を残しつつ、character 領域は re-export に寄せる
