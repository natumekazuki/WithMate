# Decisions

- 時間減衰は schema 追加ではなく retrieval score 補正として扱う
- 参照時刻は `lastUsedAt ?? updatedAt` を使う
- v1 は連続関数ではなく段階的な score 補正で十分とする
