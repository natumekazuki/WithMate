# Plan

## Goal

- Session Window の assistant response を読みやすい rich text 表示へ改善する

## Scope

- markdown-like な最小表示
- ローカルパス / URL のリンク表示
- Session chat への適用
- design docs と実機テスト項目の同期

## Task List

- [x] Plan を作成する
- [ ] message renderer を実装する
- [ ] Session Window へ適用する
- [ ] docs を同期する
- [ ] typecheck/build を通す

## Affected Files

- `src/App.tsx`
- `src/MessageRichText.tsx`
- `src/styles.css`
- `src/withmate-window.ts`
- `src-electron/preload.ts`
- `src-electron/main.ts`
- `docs/design/desktop-ui.md`
- `docs/design/message-rich-text.md`
- `docs/manual-test-checklist.md`

## Risks

- Markdown 完全互換を目指すと実装が膨らむ
- ローカルパス open の失敗時に UI を壊さない必要がある

## Design Doc Check

- 状態: 確認済み
- 対象候補: `docs/design/desktop-ui.md`, `docs/design/message-rich-text.md`, `docs/manual-test-checklist.md`
- メモ: message 表示仕様を新規 design doc に切り出す
