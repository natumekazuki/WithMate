# Plan

- task: Copilot の SessionNotFound 再発を再調査する
- date: 2026-04-03
- owner: Codex

## 目的

- `#40 まだ SessionNotFound が発生する` の原因を特定する
- user と修正方針に合意するまで、実装変更は入れない

## スコープ

- GitHub issue `#40`
- Copilot adapter の cached session / resume / internal retry 経路
- Session runtime の stale thread retry と agent 切り替え時の差分

## 進め方

1. issue 内容と既存修正履歴を確認する
2. current 実装の retry / cache invalidation 経路を調査する
3. 原因仮説と修正候補を整理し、user 合意を取る
4. 合意後に実装・検証・docs 同期を行う

## チェックポイント

- [ ] issue 内容と再現条件を整理する
- [ ] 現行 retry 実装の抜けを特定する
- [ ] 原因仮説と修正候補を提示する
- [ ] user 合意後に実装する
