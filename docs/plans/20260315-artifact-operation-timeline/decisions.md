# Decisions

## Summary

- Turn Summary の下段は要約リストではなく operation timeline として扱い、`agent_message` を command / reasoning と同じ順序で表示する

## Decision Log

### 0001

- 日時: 2026-03-15
- 論点: `Details` を開いたときに command と response の流れをどう見せるか
- 判断: artifact に `operationTimeline` を持たせ、`agent_message` を含む `turn.items` の順序を保ったまま下段へ表示する
- 理由: 現行の `activitySummary` だけだと command 実行と response の間の流れが切れて見え、Raw Items を開かないと判断しづらいため
- 影響範囲: `src/app-state.ts`, `src-electron/codex-adapter.ts`, `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/design/agent-event-ui.md`, `docs/manual-test-checklist.md`
