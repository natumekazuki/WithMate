# Companion Sibling Warning History 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

merge 完了時に返している sibling path overlap warning を terminal CompanionSession の履歴として保存し、Home の履歴カードで後から確認できるようにする。

## スコープ

- `companion_sessions` に sibling warnings の保存先を追加する。
- merge 完了時に sibling warning を保存する。
- Home の terminal CompanionSession history card に sibling warning summary を表示する。
- storage / review service の対象テストと design doc を更新する。

## 対象外

- discard 時の sibling check 実行。
- warning 詳細 modal / read-only Review Window の追加。
- `companion_merge_runs` table の追加。
- warning の解決済み状態管理。

## チェックポイント

1. [x] CompanionSession / Summary に sibling warning summary を追加する。
2. [x] storage schema と migration を追加する。
3. [x] merge 完了時に sibling warning を保存する。
4. [x] Home history card に sibling warning summary を表示する。
5. [x] 対象テストと design doc を更新する。
6. [x] archive、commit。
