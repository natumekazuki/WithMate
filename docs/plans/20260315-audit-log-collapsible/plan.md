# Plan

## Goal

- Audit Log の各 prompt / response / operations / raw items をカテゴリ単位で折りたたみ表示にし、長いログでも必要な箇所だけ段階的に読めるようにする

## Scope

- Audit Log overlay の表示構造
- 折りたたみの初期状態と開閉 UI
- 関連する design doc と実機テスト項目の更新

## Task List

- [ ] Audit Log の各セクションを `details/summary` か同等 UI へ置き換える
- [ ] デフォルトで閉じるセクションと常時表示する要素を整理する
- [ ] 可読性が落ちないよう summary の文言とレイアウトを調整する
- [ ] docs/design と manual test checklist を更新する
- [ ] `npm run typecheck` と `npm run build` を通す

## Affected Files

- src/App.tsx
- src/styles.css
- docs/design/audit-log.md
- docs/manual-test-checklist.md
- docs/plans/20260315-audit-log-collapsible/worklog.md
- docs/plans/20260315-audit-log-collapsible/decisions.md

## Risks

- `details` の多用で操作感が重くなる可能性がある
- すべて閉じすぎると、逆に重要情報へ到達しにくくなる
- 既存のテキスト選択や copy 操作がしにくくならないように注意が必要

## Design Doc Check

- 状態: 確認済み
- 対象候補: docs/design/audit-log.md, docs/design/desktop-ui.md
- メモ: Audit Log の閲覧体験変更なので design doc 更新対象に含める
