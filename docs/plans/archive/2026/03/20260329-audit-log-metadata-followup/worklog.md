# Worklog

- 開始: AuditLog metadata 拡張と overlay 初期状態整理
- `durationMs` を main/background 共通 metadata として追加
- main turn に `projectMemoryHits` と `attachmentCount` を追加
- background task に `projectMemoryPromotions` / `characterMemorySaved` などの件数 metadata を追加
- Audit Log overlay の details 初期状態をすべて collapsed に変更
- 2026-03-29: `75a88d9` `feat(session): refine audit and monologue monitoring`
  - Audit Log metadata 拡張と overlay 整理を feature commit として反映
