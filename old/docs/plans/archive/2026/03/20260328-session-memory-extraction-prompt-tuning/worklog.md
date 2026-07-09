# Worklog

- 2026-03-28: plan を開始。Session Memory extraction prompt の instruction を整理して、field ごとの役割と差分更新ルールを強める。
- 2026-03-28: extraction prompt に field guide と output rule を追加した。
  - `goal / decisions / openQuestions / nextActions / notes` の役割を systemText と userText の両方で明示
  - `差分だけ返す`、`既存 memory を繰り返さない`、`不明は省略` を hard rule として追加
  - `notes` は fallback であり durable note だけ tag を付ける前提を明文化
- 2026-03-28: `3010d32 refactor(memory): tune session extraction prompt`
