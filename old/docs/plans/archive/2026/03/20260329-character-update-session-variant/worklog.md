# 作業ログ

- 2026-03-29: 認識ズレがあった `Character Update Workspace` 専用 window 方針を撤回し、`SessionWindow` variant へ切り直した
- 2026-03-29: `CharacterEditorApp` の provider picker modal から `character-update` session を直接起動し、`SessionWindow` 側で `LatestCommand / MemoryExtract`、header、composer の variant 切替を実装した
- 2026-03-29: `openCharacterUpdate` 系の IPC / preload / aux window 経路を削除し、current docs を `SessionWindow` variant 前提へ更新した
