# 20260314 Settings Overlay

## Goal
- Home は session / character 管理ハブのまま保ち、設定系の操作は Home 上の overlay に集約する。
- 現時点では model catalog import / export を Settings overlay へ移し、将来の設定項目追加先を確保する。

## Task List
- [x] `docs/design/window-architecture.md` を overlay 方針に更新する。
- [x] `docs/design/settings-ui.md` を新規作成し、Home 配下の Settings overlay を定義する。
- [x] `docs/design/ui-react-mock.md` の Home toolbar と導線を更新する。
- [x] `docs/design/model-catalog.md` の import / export 導線を Settings overlay 前提に直す。
- [x] Home toolbar から `Import Models` / `Export Models` を外し、`Settings` ボタンに置き換える。
- [x] Home 上に Settings overlay を追加し、model catalog import / export UI を移す。
- [x] `typecheck` / `build` / `build:electron` で検証する。

## Affected Files
- `docs/design/window-architecture.md`
- `docs/design/settings-ui.md`
- `docs/design/ui-react-mock.md`
- `docs/design/model-catalog.md`
- `docs/plans/20260314-settings-window.md`
- `src/HomeApp.tsx`
- `src/styles.css`

## Risks
- Settings overlay に項目を増やしすぎると、Home の文脈とぶつかる。
- model catalog import/export の結果表示を overlay 内に閉じるため、長文フィードバックには向かない。

## Design Check
- 新しい window は増やさず、`Home Window` の一時 UI として扱う。
- model catalog の操作場所が変わるため、`docs/design/model-catalog.md` の更新が必要。
