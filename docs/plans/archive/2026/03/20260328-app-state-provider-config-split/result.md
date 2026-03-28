# Result

- 状態: completed

## メモ

- `app-state.ts` の provider config / app settings 領域を domain split した

## 完了内容

- `src/provider-settings-state.ts` を追加し、`AppSettings` と provider ごとの settings helper を分離した
- `app-state.ts` から settings 系の型定義と helper を外し、re-export に切り替えた
- settings に触る source / test import を新 module に寄せた

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/model-catalog-settings.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/settings-catalog-service.test.ts scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/home-launch-projection.test.ts scripts/tests/approval-mode.test.ts scripts/tests/session-runtime-service.test.ts scripts/tests/session-persistence-service.test.ts scripts/tests/memory-orchestration-service.test.ts scripts/tests/session-memory-extraction.test.ts scripts/tests/character-reflection.test.ts scripts/tests/provider-prompt.test.ts`

## 次

- 次は `app-state.ts` に残っている `Session / Character` shared type の split を検討する
