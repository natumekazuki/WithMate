# Companion run turn 実装 Decisions

## 2026-04-26

- Companion の provider 実行は通常 Session table に相乗りせず、CompanionSession を provider runtime 用の一時 Session 形状へ変換して実行する。
- provider には `executionWorkspacePath` として `CompanionSession.worktreePath` を渡す。
- 初期実装では Companion の MemoryGeneration / CharacterReflection は実行しない。
