# Companion Mode MVP 実装 Decisions

## 決定

- 2026-04-26: 最初の実装単位は CompanionSession 作成と Home での可視化までとする。
- 2026-04-26: snapshot / shadow worktree / merge / review window は、専用 table と起動導線が通った後の後続チェックポイントへ分ける。
- 2026-04-26: `docs/design/companion-mode.md` を正本仕様として扱い、実装で明確になった current schema は `docs/design/database-schema.md` に反映する。

## 保留

- Companion Review Window の entry HTML / window type は、最小 storage / launch 導線の完了後に決める。
- snapshot commit と shadow worktree の具体 command 列は、今回の最小実装後に別チェックポイントで実装する。
