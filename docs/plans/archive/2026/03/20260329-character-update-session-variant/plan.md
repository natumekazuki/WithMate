# 目的

- `sessionKind === "character-update"` の session を、通常の `SessionWindow` とは別の表示バリアントとして最適化する
- `Character Update Workspace` 専用画面として実装してしまった認識ズレを解消する

# スコープ

- `src/App.tsx`
- `src/session-components.tsx`
- `src/session-ui-projection.ts`
- `src/CharacterEditorApp.tsx`
- `src/character-main.tsx`
- `src/withmate-window-api.ts`
- `src-electron/preload-api.ts`
- `src-electron/main-ipc-registration.ts`
- `src-electron/main-ipc-deps.ts`
- `src-electron/main-window-facade.ts`
- `src-electron/aux-window-service.ts`
- `src-electron/window-entry-loader.ts`
- 関連 test
- `docs/design/character-update-workspace.md`
- `docs/design/character-management-ui.md`
- 必要なら `docs/design/desktop-ui.md`

# 進め方

1. `Character Update Workspace` 専用 window 導線を外し、Character Editor からは provider picker modal で直接 update session を起動する
2. `SessionWindow` に `character-update` variant を追加する
3. `LatestCommand / MemoryExtract`、header、composer を `character-update` 向けに調整する
4. docs と test を current に合わせ、build と関連 test で確認する
