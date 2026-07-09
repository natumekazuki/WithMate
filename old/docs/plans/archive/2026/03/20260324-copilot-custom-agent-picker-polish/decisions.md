# Decisions

## 2026-03-24

- picker に出す custom agent は `user-invocable: true` の定義だけにする
- Copilot session config に渡す `customAgents` catalog 自体は引き続き discovery 結果全体を使う
- 選択中 agent の可視化は既存 composer settings 内の読み取り専用表示で足す
