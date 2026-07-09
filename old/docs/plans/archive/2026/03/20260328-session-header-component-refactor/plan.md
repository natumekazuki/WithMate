# Plan

- 日付: 2026-03-28
- タスク: Session header の component 分離

## 目的

- `src/App.tsx` に残っている session header / drawer / title edit UI を `src/session-components.tsx` に切り出す
- `App.tsx` は session renderer の composition と state 管理に寄せる

## 完了条件

- `SessionHeader` が追加されている
- `App.tsx` の session header JSX が component 呼び出しへ置き換わっている
- `npm run build` が通る
- `docs/design/refactor-roadmap.md` に進捗が反映されている
