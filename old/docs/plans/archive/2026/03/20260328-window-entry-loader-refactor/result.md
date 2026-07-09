# Result

- 状態: completed

## 完了内容

- `src-electron/window-entry-loader.ts` を追加した
- `home / session / character / diff` の entry 読み込み helper を service 化した
- `devServerUrl` と `dist` の読み込み分岐を `main.ts` から外した
- `SessionWindowBridge` も `WindowEntryLoader` 経由で `session.html` を開くようにした

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/window-entry-loader.test.ts scripts/tests/character-runtime-service.test.ts scripts/tests/window-dialog-service.test.ts`

## 次の候補

- `main.ts` に残る generic helper の置き場整理
