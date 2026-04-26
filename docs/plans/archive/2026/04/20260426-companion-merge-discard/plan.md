# Companion Merge / Discard 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

Review Window から selected files を target workspace へ merge し、CompanionSession を merged / discarded へ遷移できるようにする。

## スコープ

- selected files の default selected state と checkbox UI を Review Window に追加する。
- Review Window から `Merge Selected Files` / `Discard Companion` を実行する IPC / preload / renderer API を追加する。
- selected files を base snapshot commit と照合し、対象 path が target workspace 側で base から変わっていない場合だけ shadow worktree から target workspace へ反映する。
- merge / discard 完了後に CompanionSession status を `merged` / `discarded` へ更新し、companion worktree / branch / snapshot ref を cleanup する。
- Home の active CompanionSession 一覧から完了済み session が消えることを既存 storage 更新で担保する。
- 対象テストと design doc を更新する。

## 対象外

- hunk 単位 merge。
- target branch 全体の drift / dirty worktree 完全判定。
- merge simulation / conflict editor。
- sibling CompanionSession check。
- checks / CI integration。
- merge result 専用 table の追加。

## チェックポイント

1. [x] 既存 IPC / storage / cleanup の接続点を確認する。
2. [x] merge / discard service と Git file apply を追加する。
3. [x] IPC / preload / renderer API を追加する。
4. [x] Review Window UI に checkbox と actions を追加する。
5. [x] design doc と検証を更新する。
6. [x] archive、commit。
