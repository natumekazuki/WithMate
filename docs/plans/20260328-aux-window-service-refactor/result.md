# Result

- 状態: completed

## 完了内容

- `src-electron/aux-window-service.ts` を追加した
- `Home / Monitor / Settings / CharacterEditor / Diff` の window 生成 / 再利用 / registry を service 化した
- diff preview token 管理と reset 時 close を service 側へ寄せた
- `main.ts` から non-session window の window 管理 helper を削除した

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/aux-window-service.test.ts scripts/tests/window-entry-loader.test.ts scripts/tests/window-dialog-service.test.ts scripts/tests/character-runtime-service.test.ts`

## 次の候補

- `main.ts` に残る generic helper の置き場整理
