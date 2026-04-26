# Companion Changed Files History 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

merge / discard 済み CompanionSession の履歴カードで changed file summary を確認できるようにする。

## スコープ

- `companion_sessions` に changed files summary の保存先を追加する。
- merge / discard 完了時に cleanup 前の changed files summary を保存する。
- Home の terminal CompanionSession history card に changed files summary を表示する。
- storage / review service の対象テストと design doc を更新する。

## 対象外

- diff rows / file contents の永続化。
- sibling warning の永続化。
- `companion_merge_runs` table の追加。
- read-only Review Window の実装。

## チェックポイント

1. [x] CompanionSession / Summary に changed file summary を追加する。
2. [x] storage schema と migration を追加する。
3. [x] merge / discard 完了時に changed files summary を保存する。
4. [x] Home history card に changed files summary を表示する。
5. [x] 対象テストと design doc を更新する。
6. [x] archive、commit。
