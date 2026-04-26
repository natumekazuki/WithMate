# Companion Selected Files History 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

merge 済み CompanionSession の履歴カードで selected files summary を確認できるようにする。

## スコープ

- `companion_sessions` に selected files の保存先を追加する。
- selected files merge 完了時に normalized selected paths を保存する。
- Home の terminal CompanionSession history card に selected files summary を表示する。
- storage / review service の対象テストと design doc を更新する。

## 対象外

- changed file summary の永続化。
- sibling warning の永続化。
- `companion_merge_runs` table の追加。
- read-only Review Window の実装。

## チェックポイント

1. [x] CompanionSession / Summary に selected paths を追加する。
2. [x] storage schema と migration を追加する。
3. [x] merge 完了時に selected paths を保存する。
4. [x] Home history card に selected files summary を表示する。
5. [x] 対象テストと design doc を更新する。
6. [x] archive、commit。
