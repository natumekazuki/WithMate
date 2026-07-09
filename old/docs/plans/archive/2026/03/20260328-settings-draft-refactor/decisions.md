# Decisions

## Decision 1: draft 更新は pure function に寄せる

- React state setter の中で都度 `get*ProviderSettings()` と `coerceModelSelection()` を組み立てるのをやめる
- `HomeApp` からは helper を呼ぶだけにする

## Decision 2: AppSettings 全体を入力に取る

- coding / memory extraction / character reflection の各 draft は相互に fallback を持つ
- helper には部分 map だけでなく、current の draft 全体を渡して整合を取る
