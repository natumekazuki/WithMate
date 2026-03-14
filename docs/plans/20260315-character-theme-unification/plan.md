# Plan

## Goal

- Home / Character Editor / Session でキャラカラーの使い方を統一する
- まず Home の card 表現を `main = 背景 / sub = 左アクセント` に揃える
- 背景色に対して文字色が潰れないよう、自動コントラスト決定の土台を入れる

## Scope

- Home の session card
- Home の character card
- Home の card theme helper
- 関連 design doc と実機テスト項目

## Task List

- [x] Plan を作成する
- [x] Home card の theme rule を `main / sub` 基準へリセットする
- [x] background から前景色を自動決定する helper を追加する
- [x] design doc / manual test を更新する
- [ ] Character Editor へ同じ theme rule を適用する
- [ ] Session へ同じ theme rule を適用する

## Affected Files

- `src/HomeApp.tsx`
- `src/ui-utils.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/design/home-ui-brushup.md`
- `docs/manual-test-checklist.md`

## Risks

- 彩度の高い `main` 色では Home の dark shell とぶつかる可能性がある
- foreground 自動決定は可読性を改善するが、ブランド感までは保証しない

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`
- メモ: Home の card theme rule を明文化する
