# Companion Review Timeline 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

Companion Review Window で `companion_merge_runs` の複数履歴を timeline として表示し、terminal CompanionSession の操作履歴を確認しやすくする。

## スコープ

- `CompanionReviewSnapshot` に merge run timeline を追加する。
- Review service が session の merge runs を snapshot に含める。
- Review Window に merge / discard timeline を表示する。
- 対象テストと design doc を更新する。

## 対象外

- timeline item から過去 diff を個別復元する機能。
- diff snapshot / file contents の永続化。
- merge run の削除・編集 UI。

## チェックポイント

1. [x] Review snapshot に merge run timeline を追加する。
2. [x] Review Window に timeline を表示する。
3. [x] 対象テストと design doc を更新する。
4. [x] archive、commit。
