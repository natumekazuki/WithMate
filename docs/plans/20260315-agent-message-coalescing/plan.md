# Plan

## Goal

- `turn.items` に複数の `agent_message` が含まれる場合でも、Session chat と live pending bubble で内容が欠けないようにする

## Scope

- `src-electron/codex-adapter.ts` の assistant text 集約
- 関連 design doc と実機テスト項目の同期

## Task List

- [x] 現状の `agent_message` 集約ロジックを確認する
- [x] 複数 `agent_message` を arrival 順に連結する helper を実装する
- [x] design doc と実機テスト項目を更新する
- [ ] コミットを作成して worklog に記録する

## Affected Files

- `src-electron/codex-adapter.ts`
- `docs/design/provider-adapter.md`
- `docs/design/audit-log.md`
- `docs/manual-test-checklist.md`

## Risks

- `agent_message` の順序が SDK の event 到着順に依存する
- 既存 UI は 1 assistant message 前提なので、個別 message 分割ではなく連結で扱う

## Design Doc Check

- 状態: 確認済み
- 対象候補: `docs/design/provider-adapter.md`, `docs/design/audit-log.md`, `docs/manual-test-checklist.md`
- メモ: provider 実行結果の集約仕様と監査確認手順に変更が入るため更新する
