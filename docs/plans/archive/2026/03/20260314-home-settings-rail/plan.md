# Plan

## Goal

- Home の `Settings` を重ね置きせず、`Characters` の上に専用領域を切って収まりを改善する。

## Scope

- `src/HomeApp.tsx` の Home レイアウト調整
- `src/styles.css` の Home レイアウト調整
- 関連 design doc 更新
- 本 Plan の記録更新

## Task List

- [x] Home の右カラムに `Settings` rail を追加する
- [x] 重ね置き前提の CSS を削除してレイアウトを安定させる
- [x] design doc を現行レイアウトへ更新する
- [x] `typecheck` と `build` で確認する

## Affected Files

- `src/HomeApp.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/design/home-ui-brushup.md`
- `docs/plans/20260314-home-settings-rail/plan.md`
- `docs/plans/20260314-home-settings-rail/decisions.md`
- `docs/plans/20260314-home-settings-rail/worklog.md`
- `docs/plans/20260314-home-settings-rail/result.md`

## Risks

- 右カラムの縦レイアウト変更で `Characters` パネルの高さ計算が崩れる可能性がある
- モバイル幅で `Settings` ボタンが不自然に伸びる可能性がある

## Design Doc Check

- 状態: 確認済み
- 対象候補: `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`
- メモ: Home の `Settings` 配置説明を現行実装に合わせて更新する
