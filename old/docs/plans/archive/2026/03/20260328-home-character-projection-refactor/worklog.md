# Worklog

- 2026-03-28: plan を開始。Home の Characters 右ペインにある検索結果と empty state の派生状態を helper に分離する。
- 2026-03-28: `src/home-character-projection.ts` を追加。Characters 右ペインの filtered list と empty state を helper に移し、launch helper から main character search の責務も外した。
- 2026-03-28: `706e530` `refactor(home): extract character projection helpers`
  - Characters 右ペインの projection helper を追加
  - launch helper から main character search を分離
  - search / empty state を test で固定
