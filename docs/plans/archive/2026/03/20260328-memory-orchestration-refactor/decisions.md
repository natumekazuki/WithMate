# Decisions

## Decision 1: Session Memory と Character Reflection を同時に扱う

- current 実装では両方とも `main.ts` の background orchestration に乗っている
- trigger / audit / persistence の形が似ているため、同じ refactor wave で扱う

## Decision 2: retrieval / ranking は触らない

- 現在の hotspot は orchestration であり、ranking ロジックではない
- 先に起動点と責務境界を切ってから、必要なら後続で retrieval を見直す
