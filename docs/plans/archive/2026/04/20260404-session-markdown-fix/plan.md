# 20260404-session-markdown-fix

## 目的

- Session Window で `**message**` が markdown として render されない問題を直す
- 現行の message rich text の許容範囲を崩さず、既存の path link や code 表示との両立を保つ

## スコープ

- `src/` の message rich text 実装
- 必要なら関連 style / test
- `docs/design/` と `docs/task-backlog.md`

## 方針

- まず current renderer の tokenization と render path を確認する
- `**bold**` が落ちる原因を最小差分で修正する
- 既存の `@path` / inline code / block code の表示を壊さない

## 検証

- 関連 test
- `npm run build`
