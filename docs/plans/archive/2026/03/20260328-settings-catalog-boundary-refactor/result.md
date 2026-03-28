# Result

- 状態: 完了

## Summary

- `src-electron/settings-catalog-service.ts` を追加し、`app settings` 更新と `model catalog` import / rollback / broadcast を service に集約した
- `src/home-settings-view-model.ts` を追加し、renderer 側の provider row 組み立てと normalized provider settings 再構成を helper に分離した

## Verification

- `node --test --import tsx scripts/tests/settings-catalog-service.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts`
- `npm run build`

## Notes

- catalog export / reset 経路の完全集約は follow-up に残す
