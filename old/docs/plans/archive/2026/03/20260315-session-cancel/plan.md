# Plan

- Session 実行中に `Cancel` を押して中断できるようにする。
- Main Process で `AbortController` を保持し、Codex SDK の `signal` に渡す。
- 監査ログは 1 turn 1 record を維持し、キャンセルは `CANCELED` として残す。
- Session UI は `Send` の代わりに `Cancel` を出し、完了後は通常状態へ戻す。
- `docs/design/session-run-lifecycle.md` と `docs/manual-test-checklist.md` を更新する。
