# Companion shadow worktree 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

CompanionSession 作成時に、target branch の HEAD を安全な snapshot ref として固定し、その snapshot から Companion 専用の shadow worktree を作成する。

## スコープ

- CompanionSession 作成時に `refs/withmate/companion/<safe-session-id>/base` を作成する。
- snapshot ref から `withmate/companion/<safe-session-id>` branch を作成する。
- `appDataPath/companion-worktrees/<safe-group-id>/<safe-session-id>` に Git worktree を作成する。
- 作成した snapshot ref を CompanionSession に保存する。
- 失敗時に作りかけの branch / worktree / ref を可能な範囲で掃除する。
- 対象テストと設計書を更新する。

## 対象外

- provider 実行 cwd の shadow worktree 切り替え。
- Companion Review Window。
- selected files merge / discard。
- sibling check。
- hunk 単位 merge。

## チェックポイント

1. 完了: 現行 storage / Git helper の構造確認。
2. 完了: snapshot ref / branch / worktree 作成 API の追加。
3. 完了: CompanionSessionService への作成フロー組み込み。
4. 完了: DB schema / shared type / docs 更新。
5. 完了: テストと build 検証。
6. 完了: commit と plan archive。
