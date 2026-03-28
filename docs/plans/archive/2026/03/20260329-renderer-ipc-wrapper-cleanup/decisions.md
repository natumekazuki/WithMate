# 20260329 Renderer IPC Wrapper Cleanup Decisions

## 初期判断

- first slice は `withWithMateApi` 相当の最小 helper を追加する
- `HomeApp` と `CharacterEditorApp` の薄い wrapper を優先して寄せる
- `App.tsx` は大きいため、追加変更は最小限に留める
