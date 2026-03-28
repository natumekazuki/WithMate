# Result

- status: completed

## 変更概要

- `Character Update Window` を追加し、character directory を workspace にした update 導線を実装した
- `Character Editor` から `Update Workspace` を開けるようにした
- provider ごとに `AGENTS.md` / `copilot-instructions.md` を生成して通常の Session を起動できるようにした
- `Character Memory` から deterministic な貼り付け用 markdown を生成する `Extract Memory` helper を追加した

## 検証

- `node --import tsx scripts/tests/character-update-memory-extract.test.ts`
- `node --import tsx scripts/tests/character-update-workspace-service.test.ts`
- `node --test --import tsx scripts/tests/window-entry-loader.test.ts scripts/tests/preload-api.test.ts scripts/tests/main-window-facade.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-character-facade.test.ts scripts/tests/main-ipc-registration.test.ts`
- `npm run build`
