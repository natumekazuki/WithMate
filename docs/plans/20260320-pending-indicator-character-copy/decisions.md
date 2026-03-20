# Decisions

## Summary

- 判定: new-plan
- 理由: 既存の pending indicator persistence task とは目的が異なり、今回は表示ロジックではなく user-facing copy と docs sync が主題だから
- 推奨案: pending indicator の assistant 状態文言は character 名ベースで扱い、system 用語は現状維持する

## Decision Log

### 0001

- 日時: 2026-03-20
- 論点: この修正は既存の pending indicator persistence task に含めるべきか
- 判断: 含めず、新しい repo plan として分離する
- 理由: persistence task は run 中 indicator の表示継続がテーマであり、今回の論点は user-facing copy のコンセプト整合と docs sync だから
- 影響範囲: `docs/plans/20260320-pending-indicator-character-copy/`, `src/App.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0002

- 日時: 2026-03-20
- 論点: どの文言をキャラ寄りに寄せ、どの文言を system 用語のまま残すか
- 判断: assistant の user-facing 状態文言のみ character 名ベースに寄せ、state / type / provider などの system 用語は現状維持とする
- 理由: コンセプト整合と操作理解の両立が必要であり、system 用語まで同時に変えると変更範囲と検証観点が膨らむから
- 影響範囲: `src/App.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0003

- 日時: 2026-03-20
- 論点: copy 変更に伴うレイアウト調整は同じ plan に含めるか
- 判断: pending indicator 周辺に閉じる軽微な `src/styles.css` 調整は same-plan で扱う
- 理由: 行長変化による崩れを防ぐための前提作業であり、独立 task に分けるほど目的が独立していないから
- 影響範囲: 必要なら `src/styles.css`
