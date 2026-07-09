# Result

## 状態

- 完了

## サマリ

- Copilot でも `Image` ボタンを共通 UI のまま使えるようにし、画像は `file attachment` として送る形にそろえた
- provider 差分は adapter 内に閉じ、renderer 側の provider 分岐をなくした

## 次アクション

- `node --import tsx scripts/tests/copilot-adapter.test.ts` と `npm run build` で確認する

## Related Commits

- `3f2eec8` `feat(copilot): treat images as file attachments`
