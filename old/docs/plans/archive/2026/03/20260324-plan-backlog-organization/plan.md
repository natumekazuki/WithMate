# Plan

## 背景

- `docs/plans/` 配下に 2026-03-22 起票の未 archive plan が 3 件残っている
- 直近で完了済み変更のコミット記録が archive 側 plan に反映しきれていない可能性がある

## 目的

- 未 archive plan の状態を棚卸しし、継続・完了・archive 候補を整理する
- 必要な plan には最新の実装・コミット状況を反映する

## 進め方

1. 未 archive plan の `plan.md` / `worklog.md` / `result.md` を確認する
2. 実コードと git 履歴を照合して状態不整合を洗い出す
3. archive 可能なものを閉じ、継続が必要なものは次アクションを明記する
