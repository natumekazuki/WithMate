# Decisions

## 2026-03-28

- `session header` は表示専用 component として切り出し、state は引き続き `App.tsx` が保持する
- title edit の保存・削除・close 確認の挙動は変えず、callback 結線だけ移す
