# Plan

## Goal

- 現時点で実装済みの Electron デスクトップ機能を網羅する実機テスト項目表を作成する
- 実機テスト項目表を最新化する責務を Design Doc と ADR に明文化する

## Scope

- `docs/manual-test-checklist.md` の新規作成
- 実機テスト最新化方針の Design Doc 追加
- 実機テスト最新化方針の ADR 追加
- README と既存 Design Doc への導線追加

## Task List

- [x] 現行 UI / runtime 仕様から実装済み機能を洗い出す
- [x] 実機テスト項目表を作成する
- [x] 最新化方針を Design Doc に明記する
- [x] 最新化方針を ADR に明記する
- [x] README と既存 Design Doc に導線を追加する
- [x] Plan を完了状態にして archive へ移動する

## Affected Files

- `docs/manual-test-checklist.md`
- `docs/design/manual-test-checklist.md`
- `docs/design/desktop-ui.md`
- `docs/design/window-architecture.md`
- `docs/adr/001-manual-test-checklist-policy.md`
- `README.md`

## Risks

- 実装済み機能の洗い出し漏れがあると、実機テスト項目表がすぐ古くなる
- 設計更新方針を README / Design / ADR のどこにも明記しないと、次回以降の更新責務が曖昧なまま残る

## Design Doc Check

- 状態: 確認済み
- 対象候補:
  - `docs/design/desktop-ui.md`
  - `docs/design/window-architecture.md`
  - `docs/design/settings-ui.md`
  - `docs/design/model-catalog.md`
  - `docs/design/session-persistence.md`
  - `docs/design/session-run-lifecycle.md`
- メモ:
  - 現行 UI と runtime の振る舞いは `desktop-ui.md` と `window-architecture.md` が入口になっている
  - 実機テスト最新化ポリシーは専用 Design Doc と ADR を追加し、既存入口文書から参照させる
