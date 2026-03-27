# Plan

- 作成日: 2026-03-28
- タスク: Session 右ペインを `Latest Command / Memory生成 / 独り言` の切り替えにする

## Goal

- 右ペインに `Latest Command`、`Memory生成`、`独り言` の 3 面を持たせる
- それぞれに対応する処理が動いた時は自動で対象面へ切り替える
- `Latest Command` は最優先とする

## Scope

- `src/app-state.ts`
- `src/withmate-window.ts`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src/App.tsx`
- `src/styles.css`
- 関連 design doc / manual test

## Out Of Scope

- monologue 実行本体
- Character Stream の backend
- 新しい memory extraction trigger

## Checks

1. 右ペインに 3 つの切り替えボタンが出る
2. memory extraction 実行中は `Memory生成` 面へ自動切り替えられる
3. command 実行中は常に `Latest Command` が優先される
4. `独り言` 面は current milestone では empty state を出す
