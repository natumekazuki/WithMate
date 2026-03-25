# Worklog

- 2026-03-25: Copilot 先行の rate limit 可視化 plan を作成した。
- 2026-03-25: `Premium Requests = global`, `Context Usage = session local` の方針で UI / state の前提を整理した。
- 2026-03-25: `docs/design/provider-usage-telemetry.md` を作成し、state / IPC / update timing / Session UI を設計した。
- 2026-03-25: `src/App.tsx` と `src/styles.css` に Copilot 用 `Premium Requests` / `Context` の preview UI を追加し、見た目のすり合わせを先行できる状態にした。
- 2026-03-25: Main Process に provider quota telemetry cache と session context telemetry cache、IPC snapshot / subscribe、Copilot adapter の `getQuota()` / `assistant.usage` / `session.usage_info` bridge を実装した。
- 2026-03-25: Session Window の preview UI を実データ表示へ置き換え、`Premium Requests` strip と collapsed `Context` details を backend と接続した。
- 2026-03-25: `docs/design/provider-adapter.md`、`docs/design/desktop-ui.md`、`docs/manual-test-checklist.md`、`docs/task-backlog.md` を current 実装へ同期した。
