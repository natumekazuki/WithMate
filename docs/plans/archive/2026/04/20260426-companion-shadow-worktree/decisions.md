# Companion shadow worktree 実装 Decisions

## 2026-04-26

- CompanionSession の branch / ref / worktree 名は DB の session id から safe id を作って決める。
- 初期実装では snapshot / worktree 作成までを扱い、AI 実行 cwd 切り替えと Review Window は後続タスクに分ける。
- snapshot ref は `refs/withmate/companion/<safe-session-id>/base` とする。
