# Companion Read-only Review History 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

terminal CompanionSession の履歴カードから read-only Review Window を開き、`companion_merge_runs` に保存した merge / discard 操作履歴を確認できるようにする。

## スコープ

- CompanionSession summary に latest merge run を載せる。
- Home の terminal CompanionSession history card を read-only Review Window 起動導線にする。
- terminal CompanionSession 向けの read-only review snapshot を `companion_merge_runs` から生成する。
- 対象テストと design doc を更新する。

## 対象外

- cleanup 後の file contents / diff rows 復元。
- merge run 詳細 modal の追加。
- 複数 merge run の timeline 表示。
- terminal CompanionSession の再 merge / 再 discard 操作。

## チェックポイント

1. [x] summary に latest merge run を追加する。
2. [x] terminal review snapshot を生成する。
3. [x] Home history card から read-only Review Window を開く。
4. [x] 対象テストと design doc を更新する。
5. [x] archive、commit。
