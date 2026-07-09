# Decisions

## Summary

- Session Window の wide desktop 実装は 2 カラム構成で進め、右 rail は `Activity Monitor` と `Turn Inspector` の host にする

## Decision Log

### 0001

- 日時: 2026-03-22
- 論点: 初回実装で `Turn Inspector` を何に紐づけるか
- 判断: 最新 assistant message を対象にする
- 理由: message 選択 state を増やさずに右 rail を成立させられるため
- 影響範囲: `src/App.tsx`, `src/styles.css`

### 0002

- 日時: 2026-03-22
- 論点: splitter の幅保存をどこまでやるか
- 判断: 初回は renderer local state で動かし、永続化は follow-up にする
- 理由: layout 骨格の実装を先に終わらせ、保存方式で schema を増やさないため
- 影響範囲: `src/App.tsx`, `src/styles.css`
