# Companion Merge Runs 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

merge / discard の terminal 操作を `companion_sessions` の summary カラムだけでなく、`companion_merge_runs` table に履歴として保存できるようにする。

## スコープ

- `companion_merge_runs` table と storage API を追加する。
- merge / discard 完了時に merge run を保存する。
- storage / review service の対象テストと design doc を更新する。

## 対象外

- Home 履歴カードの表示元を `companion_merge_runs` へ切り替える。
- merge run 詳細 UI / read-only Review Window の追加。
- failed / blocked merge attempt の履歴化。
- `companion_sibling_checks` table の追加。

## チェックポイント

1. [x] Companion merge run 型を追加する。
2. [x] storage schema と CRUD を追加する。
3. [x] merge / discard 完了時に merge run を保存する。
4. [x] main service wiring を追加する。
5. [x] 対象テストと design doc を更新する。
6. [x] archive、commit。
