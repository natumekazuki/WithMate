# Decisions

## 2026-03-24

- Copilot custom agent の探索元は `~/.copilot/agents` と `session.workspacePath/.github/agents` とする
- 同名 agent は workspace 側を優先して dedupe する
- 選択結果は session metadata に保存し、adapter が `customAgents` / `agent` へ変換する
