# Plan

## Goal
- Home の Recent Sessions に session 検索を追加し、タイトルと workspace の部分一致で絞り込めるようにする。

## Scope
- `src/HomeApp.tsx`
- `src/styles.css`
- `docs/design/recent-sessions-ui.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Task List
- [x] Home に session 検索入力を追加する
- [x] `taskTitle` と `workspacePath` の部分一致で chip と一覧を絞り込む
- [x] 検索結果 0 件の空状態を整える
- [x] docs 更新と検証を行う

## Affected Files
- src/HomeApp.tsx
- src/styles.css
- docs/design/recent-sessions-ui.md
- docs/design/desktop-ui.md
- docs/manual-test-checklist.md

## Risks
- フィルタ条件が強すぎると `running / interrupted` chip が消えて見落としやすくなる

## Design Doc Check
- 状態: 確認済み
- 対象候補: docs/design/recent-sessions-ui.md, docs/design/desktop-ui.md
- メモ: Home の resume picker に検索導線が増えるため current behavior を更新する
