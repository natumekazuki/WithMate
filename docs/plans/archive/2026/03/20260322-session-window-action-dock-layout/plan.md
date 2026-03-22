# Plan

## Goal

- SessionWindow を「中央 2 分割 + 下段 Action Dock」へ再配置し、右ペインを `Latest Command` の安全確認専用面へ簡素化する

## Scope

- `src/App.tsx` の SessionWindow layout 再構成
- `src/styles.css` の SessionWindow layout / right pane / action dock 調整
- `docs/design/desktop-ui.md`、`docs/design/session-live-activity-monitor.md`、`docs/design/session-window-layout-redesign.md`、`docs/manual-test-checklist.md` の同期

## Out of Scope

- `Character Stream` 本体実装
- provider adapter や liveRun schema の変更
- Home / Character Editor / Diff Window の改修

## Task List

- [x] plan を作成する
- [x] SessionWindow を中央 2 分割 + 下段 Action Dock へ組み替える
- [x] 右ペインを `Latest Command` 1 件表示へ簡素化する
- [x] docs / manual test を同期する
- [x] `npm run typecheck` と `npm run build` で検証する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/design/session-live-activity-monitor.md`
- `docs/design/session-window-layout-redesign.md`
- `docs/manual-test-checklist.md`
- `docs/plans/archive/2026/03/20260322-session-window-action-dock-layout/*`

## Risks

- splitter / narrow layout fallback の CSS が SessionWindow 全体を崩す可能性がある
- `Activity Monitor` 依存の copy や manual test 項目が古いまま残る可能性がある
- command 情報を削りすぎると safety monitor として弱くなる可能性がある

## Design Doc Check

- 状態: 更新予定
- 対象: `docs/design/desktop-ui.md`, `docs/design/session-live-activity-monitor.md`, `docs/design/session-window-layout-redesign.md`
- メモ: SessionWindow の面構成と右ペイン責務を変更するため docs 更新が必要
