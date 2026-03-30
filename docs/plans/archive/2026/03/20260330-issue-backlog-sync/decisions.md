# 決定

## 2026-03-30

- 対象 GitHub リポジトリは `origin` remote から確認できる `natumekazuki/WithMate` とする
- issue 取得は `gh issue list --repo natumekazuki/WithMate --state all/open` を正本として扱う
- `docs/task-backlog.md` は issue の state をそのまま転記するのではなく、repo 内の実装状況も併記する運用を維持する
- `docs/design` は参照のみ行い、backlog 同期だけで設計本文の更新は不要と判断する
- `.ai_context` は repo 直下に存在しないため、current task では更新対象なしとして扱う
