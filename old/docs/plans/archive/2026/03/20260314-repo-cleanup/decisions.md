# Decisions

## Summary

- 現状差分は先にスナップショットとしてコミットし、その後で cleanup を別コミットに分離する
- cleanup では Electron 実行系を正本にし、browser fallback / localStorage mock は撤去対象とする
- 旧モック資産や完了済み旧 Plan は、必要な履歴は残しつつ active な面から外す

## Decision Log

### 0001

- 日時: 2026-03-14
- 論点: 現状差分をそのまま cleanup するか、先に固定するか
- 判断: 先に現状スナップショットを 1 コミット作成する
- 理由: ここまでの試行錯誤を復元可能にしたうえで、cleanup を安全に進めるため
- 影響範囲: Git 履歴、Plan の checkpoint 管理

### 0002

- 日時: 2026-03-14
- 論点: browser fallback / localStorage mock を残すか
- 判断: Electron 実行系を正本とし、browser fallback は cleanup 対象とする
- 理由: 現在は Electron 実アプリとして成立しており、fallback と mock 命名が残滓として実装・docs を濁しているため
- 影響範囲: `src/`, `src-electron/`, `docs/design/`, `README.md`

### 0003

- 日時: 2026-03-14
- 論点: 旧 Plan / 旧モック docs をどう扱うか
- 判断: active な `docs/plans/` と `docs/design/` からは外し、必要な履歴は archive へ移す
- 理由: 現行仕様と過去の試作記録を分離し、入口をクリーンに保つため
- 影響範囲: `docs/plans/`, `docs/design/`
