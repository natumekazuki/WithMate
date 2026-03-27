# Worklog

- 2026-03-28: plan を開始。`Session Memory` 完了後に `Project Memory` へ durable knowledge を昇格する最小ルールを実装対象にする。
- 2026-03-28: `decisions` と tag 付き `notes` だけを昇格する rule-based promotion を実装した。
  - `src-electron/project-memory-promotion.ts` を追加
  - session memory extraction 完了後に `project_memory_entries` へ upsert
  - `goal / openQuestions / nextActions` は昇格しない current 仕様を docs と test に反映
