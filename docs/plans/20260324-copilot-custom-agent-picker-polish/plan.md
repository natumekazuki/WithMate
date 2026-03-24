# Plan

## 背景

- Copilot custom agent picker 実装後、`.agent.md` の `user-invocable` frontmatter を見ていない
- Session UI 上で現在どの custom agent を選んでいるかが一目で分からない

## 目的

- picker に表示する custom agent を `user-invocable: true` の定義だけに絞る
- Session UI に現在選択中の custom agent を可視化する

## スコープ

- custom agent discovery の frontmatter parsing 調整
- Session UI の選択中 agent 表示
- 関連 tests / docs 更新

## スコープ外

- Codex 側の agent UI
- custom agent authoring UX
