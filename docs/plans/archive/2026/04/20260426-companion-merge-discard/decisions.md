# Companion Merge / Discard 実装 Decisions

## 2026-04-26

- 初期実装の merge は selected files 単位に限定し、target workspace の対象 path が base snapshot commit と一致する場合だけ反映する。
- target workspace 全体の dirty 判定、merge simulation、sibling check は後続実装に残す。
- merge / discard 完了後は CompanionSession を terminal status に更新し、companion worktree / branch / snapshot ref を cleanup する。
