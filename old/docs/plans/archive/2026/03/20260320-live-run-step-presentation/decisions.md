# Decisions

## Summary

- blocking issue はなし
- `status` は固定 label table を採用し、未知値は raw fallback を維持する
- `type` は pending bubble と artifact timeline で共通 helper を使う
- `in_progress` を最優先表示し、`completed` は後段かつ subdued 表示に寄せる
- `usage` は footer 集約表示に限定する

## Decision Log

### 0001

- 日時: 2026-03-20
- 論点: `live run step` 改修の主眼をどこに置くか
- 判断: まずは「進行中の 1 件がすぐ分かること」と「完了済み step が本文を押し下げすぎないこと」を優先する
- 理由: 現状の Session では本文が主役であり、実況表示は補助情報なので、情報量より即時把握性を優先した方が UI 全体の価値が高い
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`

### 0002

- 日時: 2026-03-20
- 論点: pending bubble の `status` をどうラベル化するか
- 判断:
  - `in_progress` → `実行中`
  - `completed` → `完了`
  - `failed` → `エラー`
  - `canceled` → `キャンセル`
  - `pending` → `待機`
  - 未知値は raw fallback
- 理由: 既知状態は UI 文言として翻訳しつつ、未確認 status を UI 崩壊なしで観測できる余地を残すため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/manual-test-checklist.md`

### 0003

- 日時: 2026-03-20
- 論点: pending bubble の `type` label を operation timeline と共通化するか
- 判断: 共通化する。`operationTypeLabel()` は `src/ui-utils.tsx` へ移して pending bubble と timeline の両方から使う
- 理由: 同一 type の表記ゆれを防ぎ、今回の UI 改修を局所リファクタ込みの same-plan で閉じられるため
- 影響範囲: `src/App.tsx`, `src/ui-utils.tsx`

### 0004

- 日時: 2026-03-20
- 論点: `in_progress / completed / usage / error` の見せ方をどう整理するか
- 判断:
  - `failed` / `canceled` / `in_progress` を先頭 bucket、`completed` を後段 bucket とする
  - 同一 bucket 内は元の配列順を維持する
  - `usage` は footer 集約表示のみとし、`cached` は 0 より大きいときだけ表示する
  - `errorMessage` は独立 alert block として扱う
- 理由: active な進捗把握を優先しつつ、bubble の高さ増大を抑え、異常系を summary 群から分離できるため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/manual-test-checklist.md`
