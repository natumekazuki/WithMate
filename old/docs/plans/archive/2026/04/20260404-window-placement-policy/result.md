# 20260404-window-placement-policy result

## 状態

- 完了

## 要約

- `Home Window` 以外の新規 window は cursor がある display の workArea 起点で開くようにした
- placement は `src-electron/window-placement.ts` へ分離し、display 外にはみ出さない clamp を test で固定した
- `docs/design/window-architecture.md` と `docs/manual-test-checklist.md` を current policy に同期した
- 実装コミットは `9e1c743` `feat(window): place new windows near cursor`
