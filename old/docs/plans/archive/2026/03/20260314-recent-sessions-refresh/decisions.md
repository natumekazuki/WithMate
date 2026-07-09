# Decisions

## Summary
- Recent Sessions は resume 判断に必要な要素だけ残し、空 session は入力前メッセージを表示しない。

## Decision Log

### 0001
- 日時: 2026-03-14
- 論点: Home の session card に何を残すか
- 判断: task title / workspace path / updatedAt を残し、待機 badge と taskSummary を削除する
- 理由: idle session 一覧では待機表示が冗長で、定型の taskSummary も resume 判断の価値が弱い
- 影響範囲: Home card 表示, updatedAt 表示, Session の空状態

