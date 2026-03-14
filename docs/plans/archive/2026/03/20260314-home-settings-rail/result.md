# Result

## Status

- 状態: 完了

## Completed

- `Settings` を `Characters` の上に置く専用 rail レイアウトへ変更した
- 重ね置き前提の CSS を削除した
- Home の design docs を更新した
- `typecheck` と `build` を通した

## Remaining Issues

- なし

## Related Commits

- 未コミット

## Rollback Guide

- 戻し先候補: この Plan 着手前の `src/HomeApp.tsx` / `src/styles.css`
- 理由: `Settings` を再び浮遊 action に戻す場合は、`home-side-column` / `home-settings-rail` 導入差分を戻せばよい

## Related Docs

- `docs/design/desktop-ui.md`
- `docs/design/home-ui-brushup.md`
