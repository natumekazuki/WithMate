# Decisions

## Decision 1: first slice は right pane に絞る

- `App.tsx` 全体を一気に分割しない
- `LatestCommand / MemoryGeneration / Monologue` と provider telemetry の projection を先に切る

## Decision 2: helper は pure function にする

- React hook 依存を持たせず、state から表示用の派生値を返す pure function に寄せる
