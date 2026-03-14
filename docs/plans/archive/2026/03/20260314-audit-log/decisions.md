# Decisions

## Summary

- 監査ログは session payload と分離した SQLite table に保存する
- Session ごとに時系列で started / completed / failed を記録する
- Session Window から overlay で閲覧できるようにする

## Decision Log

### 0001

- 日時: 2026-03-14
- 論点: 監査ログを session row に埋め込むか別 table に切るか
- 判断: 別 table に切る
- 理由: session payload と責務を分け、履歴を時系列で扱いやすくするため
- 影響範囲:
  - `src-electron/audit-log-storage.ts`
  - `src-electron/main.ts`

### 0002

- 日時: 2026-03-14
- 論点: 監査ログをどう閲覧させるか
- 判断: Session Window の overlay で閲覧させる
- 理由: session 文脈のまま精査でき、別 window を増やさずに済むため
- 影響範囲:
  - `src/App.tsx`
  - `src/styles.css`