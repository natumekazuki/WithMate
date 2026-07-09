# 20260329 Renderer WithMate API Helper Refactor Worklog

- 2026-03-29: task 開始。`HomeApp`、`App`、`CharacterEditorApp`、`DiffApp` の `window.withmate` 直参照と desktop runtime 判定を棚卸し。
- 2026-03-29: `renderer-withmate-api.ts` を追加し、`DiffApp`、`CharacterEditorApp`、`HomeApp`、`App` の `window.withmate` 参照を helper 経由へ整理。
- 2026-03-29: `renderer-withmate-api.test.ts` を追加し、build と helper test で回帰確認。
- 2026-03-29: `bb0de07` `refactor(renderer): share withmate api access helper`
  - renderer からの `window.withmate` 取得を `renderer-withmate-api.ts` に共通化
  - `DiffApp`、`CharacterEditorApp`、`HomeApp`、`App` の主要な guard と API 呼び出しを helper 経由へ整理
