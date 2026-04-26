# Companion provider workspace 実装 Decisions

## 2026-04-26

- 通常 Session の永続 `workspacePath` は変更しない。
- provider 実行にだけ `executionWorkspacePath` を渡せるようにする。
- `executionWorkspacePath` が未指定の場合は従来通り `session.workspacePath` を使う。
- Companion 専用の実行 IPC / Window は後続タスクに分ける。
