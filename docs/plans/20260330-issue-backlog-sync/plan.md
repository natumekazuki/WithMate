# 目的

- GitHub の current issue 一覧を取得し、`docs/task-backlog.md` を最新の要求源に同期する
- backlog 記載と issue 実態の差分を整理し、優先度・実装状況・参照元を見直す
- `docs/design` と `.ai_context` への影響有無を確認し、更新不要ならその判断を記録する

# スコープ

- `origin` remote から対象 GitHub リポジトリを特定する
- `gh issue list` を使って issue の番号・タイトル・状態・要約材料を取得する
- `docs/task-backlog.md` の管理表、Memory 関連整理、推奨順、参照元を更新する
- `docs/plans/20260330-issue-backlog-sync/` に判断理由と作業ログを残す

# 非スコープ

- GitHub issue 自体の実装
- `docs/design` の仕様更新
- `.ai_context` の新規作成

# 進め方

1. `git remote -v` で対象リポジトリを確認する
2. `gh issue list --state all` / `--state open` で issue 一覧と要約材料を取得する
3. `docs/task-backlog.md` と照合し、追加 issue・状態差分・優先度見直し点を整理する
4. `docs/design` と `.ai_context` の更新要否を確認し、結果を plan artifacts に記録する
5. `docs/task-backlog.md` を更新し、差分と判断を `result.md` にまとめる

# 完了条件

- `docs/task-backlog.md` が 2026-03-30 時点の GitHub issue 状態を反映している
- 追加・変更理由が `decisions.md` / `worklog.md` / `result.md` で追える
- `docs/design` と `.ai_context` の扱いが明示されている
