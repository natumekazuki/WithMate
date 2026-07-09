# 2026-04-04 Copilot Tasks Pane

## 目的

- Copilot session の background tasks を `Latest Command` から分離し、右ペインの独立 tab として表示する
- `Tasks` tab は Copilot session の時だけ表示し、non-Copilot session では cycle 対象から除外する

## スコープ

- `src/session-ui-projection.ts`
- `src/App.tsx`
- `src/session-components.tsx`
- 必要な design / checklist / backlog の同期

## 進め方

1. 右ペイン tab 定義を見直し、Copilot session だけ `Tasks` を有効にする
2. `backgroundTasks` 表示を `Latest Command` から `Tasks` tab へ移す
3. design / checklist / backlog を同期する
4. render 系 test と build で確認する
