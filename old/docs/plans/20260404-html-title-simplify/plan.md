# Plan

- task: HTML title を簡素化する
- date: 2026-04-04
- owner: Codex

## 目的

- browser title / window title の表記から `WithMate` 接頭辞を外す
- 各 window の役割名だけで識別できる状態に揃える

## スコープ

- `index.html`
- `session.html`
- `character.html`
- `diff.html`

## 進め方

1. current title を確認する
2. `WithMate` を外して最小表記へ揃える
3. build で崩れないことを確認する

## チェックポイント

- [x] 4 画面の title を簡素化する
- [x] build で確認する
