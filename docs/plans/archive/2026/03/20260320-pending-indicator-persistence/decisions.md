# Decisions

## Summary

- typing indicator は空本文時の代替ではなく、実行中フラグとして扱う
- indicator の消失条件は success 固定ではなく `runState !== "running"` を基準にする
- 今回の persistence は同一 run 中の表示継続を指し、restart persistence は scope 外とする

## Decision Log

### 0001

- 日時: 2026-03-20
- 論点: pending bubble の typing indicator は本文が出始めたら消すべきか
- 判断: `assistantText` の有無に関係なく、`runState === "running"` の間は表示を維持し、`runState !== "running"` で消す
- 理由: coding agent UI では、本文が流れ始めた後もまだ処理が続いていることが多く、実行中であることを常時示した方が自然であり、消失条件を runState 基準にすると success 以外の終了も扱えるから
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0002

- 日時: 2026-03-20
- 論点: この task の persistence は restart persistence まで含むか
- 判断: 含まない。対象は同一 run 中の表示継続のみとする
- 理由: current issue は `assistantText` 出力開始で indicator が早期消失する点であり、再起動後復元は別問題だから
- 影響範囲: `docs/plans/20260320-pending-indicator-persistence/plan.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
