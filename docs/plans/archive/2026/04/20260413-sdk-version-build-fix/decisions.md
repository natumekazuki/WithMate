# Decisions

## Round 1

- @github/copilot-sdk 更新に合わせて session.idle は ackgroundTasks 前提をやめ、実行中タスクの掃除のみに変更する。
- テストは旧 ackgroundTasks スナップショットではなく system.notification の gent_idle / gent_completed 前提へ更新する。

## Round 2

- 依存ライブラリは 
pm install <package>@latest で package.json / lockfile を最新版へ更新する。
- 完了条件は 
pm run build の成功とし、
pm run typecheck の既存テスト不整合は follow-up として分離する。
- docs/design/、.ai_context/、README.md の更新は不要とする。
