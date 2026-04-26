# Companion Review Window 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

CompanionSession の base snapshot と shadow worktree の差分を Review Window で確認できるようにする。merge / discard 実行は次段階に分け、今回は変更ファイル一覧と file diff 表示までを扱う。

## スコープ

- CompanionSession から changed files を算出する Main Process service を追加する。
- Review Window 用の IPC / preload / renderer API を追加する。
- AuxWindowService / WindowEntryLoader / Vite entry に Review Window を追加する。
- Review Window で session header、changed file list、選択 file の diff を表示する。
- Home の Companion card から Review Window を開ける導線を追加する。
- 対象テストと design doc を更新する。

## 対象外

- `Merge Selected Files` の実行。
- `Discard Companion` の実行。
- hunk 単位 merge。
- target branch drift / dirty worktree / conflict simulation の完全判定。
- sibling CompanionSession check。

## チェックポイント

1. [x] 既存 diff viewer / aux window / IPC の再利用点を確認する。
2. [x] changed files 算出 service と型を追加する。
3. [x] Review Window の IPC / preload / entry を追加する。
4. [x] Review Window UI と Home 導線を追加する。
5. [x] design doc と検証を更新する。
6. [x] archive、commit。
