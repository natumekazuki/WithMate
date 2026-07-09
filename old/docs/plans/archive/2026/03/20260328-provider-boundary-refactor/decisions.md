# 20260328 Provider Boundary Refactor Decisions

## 初期判断

- まずは `実行面の整理` を優先し、prompt 仕様や output schema には踏み込まない
- `Session Memory extraction` と `Character Reflection` は background plane として同じ粒度で扱う
- first slice は interface と adapter の整理に絞る
