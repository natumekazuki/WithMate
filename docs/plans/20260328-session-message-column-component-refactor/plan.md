# Plan

- 日付: 2026-03-28
- タスク: Session message column / artifact block の component 分離

## 目的

- `src/App.tsx` に残っている message list / artifact block / pending run / follow banner の表示ロジックを `src/session-components.tsx` へ切り出す
- `App.tsx` は state と callback の結線中心にして、Session renderer の composition 層へ寄せる

## 完了条件

- `SessionMessageColumn` が追加されている
- `App.tsx` の該当 JSX が component 呼び出しへ置き換わっている
- `npm run build` が通る
- `docs/design/refactor-roadmap.md` に進捗が反映されている
