# Decisions

## Round 1

- @github/copilot-sdk 更新に合わせて session.idle は backgroundTasks 前提をやめ、実行中タスクの掃除のみに変更する。
- テストは旧 backgroundTasks スナップショットではなく system.notification の agent_idle / agent_completed 前提へ更新する。

## Round 2

- 依存ライブラリは、以下で package.json / lockfile を最新版へ更新する。
  - `npm install <package>@latest`
- 完了条件は以下とする。
  - `npm run build` の成功
  - `npm run typecheck` の既存テスト不整合は follow-up として分離する
- docs/design/、.ai_context/、README.md の更新は不要とする。
