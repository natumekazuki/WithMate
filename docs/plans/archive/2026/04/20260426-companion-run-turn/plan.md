# Companion run turn 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

CompanionSession から provider 実行へ送信できる最小 runtime 導線を追加する。AI 実行 cwd は shadow worktree を使い、会話履歴と実行状態を Companion 側で復元できる状態にする。

## スコープ

- Companion message / thread / run state の永続化を追加する。
- CompanionSession を provider runtime 用の Session 形状へ変換する。
- Companion 専用 run IPC と preload / renderer API を追加する。
- provider 実行時に `executionWorkspacePath` として `CompanionSession.worktreePath` を渡す。
- Home または既存 Companion 一覧から次実装へつなげられる API 境界を整える。
- 対象テストと design doc を更新する。

## 対象外

- Companion Window の完成 UI。
- Review Window。
- selected files merge / discard。
- hunk 単位 merge。
- Companion の MemoryGeneration / CharacterReflection。

## チェックポイント

1. [x] 既存 Session runtime / IPC の再利用点を確認する。
2. [x] Companion 永続化に message / thread / run state を追加する。
3. [x] Companion runtime service と IPC 境界を追加する。
4. [x] provider 実行で shadow worktree cwd を使うことをテストする。
5. [x] design doc と検証を更新する。
6. [x] archive、commit。
