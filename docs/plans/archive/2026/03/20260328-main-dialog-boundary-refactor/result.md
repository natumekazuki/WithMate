# Result

- 状態: completed

## 完了内容

- `src-electron/window-dialog-service.ts` を追加した
- `model catalog` の import/export を `WindowDialogService` へ移した
- `directory / file / image picker` を `WindowDialogService` へ移した
- `main.ts` から `dialog.showOpenDialog / showSaveDialog` と file I/O の重複を外した

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/window-dialog-service.test.ts scripts/tests/settings-catalog-service.test.ts scripts/tests/window-broadcast-service.test.ts`

## 次の候補

- `main.ts` に残る memory helper の service 分離
