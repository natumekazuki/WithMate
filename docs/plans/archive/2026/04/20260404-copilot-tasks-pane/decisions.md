# Decisions

## 2026-04-04

- `Tasks` は `Latest Command` の補助情報ではなく、Copilot 専用の独立 tab として扱う
- `Tasks` tab は Copilot session でのみ有効化し、Codex では表示しない
- 表示するステータスは current SDK surface で観測できる `running / completed / failed` の coarse snapshot に限定する
