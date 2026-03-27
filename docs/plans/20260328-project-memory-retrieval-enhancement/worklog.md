# Worklog

- 2026-03-28: plan を開始。日本語 query を拾いやすい lexical retrieval と `lastUsedAt` 更新を実装対象にする。
- 2026-03-28: retrieval を word token + 日本語 2-gram / 3-gram に強化した。
  - user message を主 query、`Session Memory.goal / openQuestions` を補助 query に分けた
  - ひらがなだけの低情報量 token を除外した
  - prompt に注入した entry の `lastUsedAt` を更新する storage API を追加した
  - docs と backlog を current 実装へ同期した
