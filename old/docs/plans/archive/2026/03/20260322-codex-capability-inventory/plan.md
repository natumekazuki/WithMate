# Plan

## Goal

- WithMate の current 実装で Codex 相手に何ができるかを棚卸しする
- 実装済み / 一部対応 / 未対応を分けて、次に潰す task の起点を作る
- 既存の provider / approval / slash / skill docs と current code の差を current snapshot として固定する

## Scope

- Codex 関連の design docs 確認
- Main Process / Renderer 実装の capability 棚卸し
- capability inventory doc の新規作成

## Out Of Scope

- コード実装
- manual test
- GitHub Copilot 実装

## Task List

- [x] Plan を作成する
- [x] 既存の Codex 関連 docs を確認する
- [x] CodexAdapter / Main Process / Session UI の current capability を確認する
- [x] capability inventory doc を作成する
- [x] 次に潰す task 候補を優先度つきで整理する
- [x] plan 記録を更新する

## Affected Files

- `docs/design/codex-capability-matrix.md`
- `docs/design/provider-adapter.md`

## Risks

- docs だけを読むと「設計済み」と「実装済み」が混ざる
- Codex CLI parity と WithMate canonical UI を混同すると backlog の優先順位を誤る

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/provider-adapter.md`
- メモ: capability inventory の正本 doc を新規追加する
