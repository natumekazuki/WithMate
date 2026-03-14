# Plan

## Goal
- Recent Sessions の表示要素を整理し、空 session の初期メッセージを撤去する。

## Scope
- Home の Recent Sessions card
- session の updatedAt 生成
- Session Window の空状態
- 関連 design / test docs

## Task List
- [x] Recent Sessions card から不要要素を削る
- [x] updatedAt を yyyy/MM/dd HH:mm 形式へ変更する
- [x] 空 session の初期メッセージを撤去する
- [x] docs 更新と検証を行う

## Affected Files
- src/HomeApp.tsx
- src/App.tsx
- src/app-state.ts
- src/ui-utils.tsx
- src-electron/main.ts
- docs/design/recent-sessions-ui.md
- docs/design/desktop-ui.md
- docs/manual-test-checklist.md

## Risks
- updatedAt の既存値が legacy 文字列のままだと表示揺れが残る

## Design Doc Check
- 状態: 確認済み
- 対象候補: docs/design/recent-sessions-ui.md, docs/design/desktop-ui.md
- メモ: Recent Sessions の表示要素と空 session 表示の current behavior を更新する

