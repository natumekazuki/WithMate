# 20260329 Renderer IPC Wrapper Cleanup Worklog

- 2026-03-29: task 開始。renderer 側に残る薄い `withmate` wrapper と `getWithMateApi` guard の重複を棚卸し。
- 2026-03-29: `withWithMateApi` helper を追加し、`HomeApp` の open/pick/create wrapper と `CharacterEditorApp` の save/delete を最小限整理。
- 2026-03-29: `renderer-withmate-api.test.ts` を更新し、helper callback の fallback も固定。build と helper test を通過。
- 2026-03-29: `2291b05` `refactor(renderer): simplify withmate api wrappers`
  - `withWithMateApi` helper を追加
  - `HomeApp` と `CharacterEditorApp` の薄い wrapper を helper 経由へ整理
