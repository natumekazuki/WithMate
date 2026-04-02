# theme-wcag-contrast plan

## 目的

- character theme の前景色決定を WCAG 準拠のコントラスト比ベースへ置き換える
- Home / Session / Character Editor / Diff の theme rule を同じ helper に寄せる

## 背景

- 現在は `relativeLuminance > 0.36` のような閾値判定で文字色を選んでいる
- 同じ処理が `src/theme-utils.ts`、`src/ui-utils.tsx`、`src/CharacterEditorApp.tsx` に分散している
- review `#6` では WCAG 2.1 の相対輝度と contrast ratio ベースへ直すことが求められている

## 対象

- `src/theme-utils.ts`
- `src/ui-utils.tsx`
- `src/CharacterEditorApp.tsx`
- `scripts/tests/` 配下の新規または既存 test
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `docs/task-backlog.md`

## 変更方針

1. hex / luminance / contrast ratio / foreground selection を共通 helper へ集約する
2. 前景色は dark / light の 2 候補から、target contrast を満たす方または ratio が高い方を選ぶ
3. Home card、Character Editor title、Session / Diff theme style が同じ判定結果を使うよう揃える
4. contrast helper の pure test を追加し、境界色で回帰を押さえる

## 検証

- `npm run build`
- `node --import tsx scripts/tests/theme-utils.test.ts`

## 完了条件

- 文字色決定に輝度閾値を使わず、contrast ratio ベースで選ぶ
- Home / Character Editor / Session / Diff の theme helper が重複実装を持たない
- docs と manual test checklist が current rule に同期される
