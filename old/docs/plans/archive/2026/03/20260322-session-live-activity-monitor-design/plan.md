# Plan

## Goal

- Session Window 実行中の `assistantText` と `live run step` を分離する UI 案を設計する
- command の realtime 可視性を落とさず、chat 本文の可読性を維持する構成を定義する

## Scope

- Session Window の pending / live run 表示構成
- `Activity Monitor` の配置、scroll、follow、表示対象
- 既存 design docs への反映

## Out of Scope

- 実装
- provider adapter の event schema 変更
- artifact timeline / Audit Log の構造変更

## Task List

- [x] 現行 pending bubble と live run の責務を整理する
- [x] chat surface と live activity surface の分離案を定義する
- [x] Session UI design docs へ反映する

## Affected Files

- `docs/design/session-live-activity-monitor.md`
- `docs/design/desktop-ui.md`

## Risks

- monitor を大きくしすぎると composer 周辺が詰まる
- `failed / canceled` を monitor から完全に外すと停止地点理解が弱くなる
- scroll / follow を 2 面に分けると導線が過剰になる可能性がある

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/desktop-ui.md`
- メモ: pending bubble と `Activity Monitor` の責務境界を `desktop-ui` の正本へ反映する
