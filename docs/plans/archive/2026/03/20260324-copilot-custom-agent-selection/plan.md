# Plan

## 背景

- `docs/plans/20260322-copilot-capability-rollout/` の次候補として `custom agent selection` が残っている
- `Skill` は prompt directive として実装済みだが、Copilot custom agent は session metadata と adapter option で扱う前提になっている
- Copilot SDK には `customAgents` と `agent` の session config surface がある

## 目的

- Copilot session で custom agent を選択し、session metadata に保存できるようにする
- 選択結果を `CopilotAdapter` の `customAgents` / `agent` へ反映する

## スコープ

- custom agent 探索
- session metadata / persistence への保存
- Session UI の picker 追加
- Copilot adapter への反映
- docs / manual test / 必要な自動テスト更新

## スコープ外

- Codex の `/agent` 相当実装
- slash command `/agent` parser 実装
- custom agent authoring 支援

## タスク

1. custom agent の探索元と保存先を確認する
2. session metadata と persistence を拡張する
3. Session UI に agent picker を追加する
4. Copilot adapter に `customAgents` / `agent` を渡す
5. docs / tests / build を更新して確認する
