# Decisions

- `app-state.ts` の次の split は Session shared state を優先する
- `Session` / `Message` / `StreamEntry` / `buildNewSession` / `normalizeSession` / `cloneSessions` を同じ domain module に寄せる方向で検討する
- audit / telemetry の shared type はこの slice では触らない
