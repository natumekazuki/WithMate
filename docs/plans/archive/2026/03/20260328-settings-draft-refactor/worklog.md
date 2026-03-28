# Worklog

- 2026-03-28: plan を開始。`HomeApp.tsx` に残っている settings draft 更新ロジックを helper に分離する。
- 2026-03-28: `src/home-settings-draft.ts` を追加。coding provider、memory extraction、character reflection の draft 更新ロジックを pure function に分離した。
- 2026-03-28: `scripts/tests/home-settings-draft.test.ts` を追加。draft 更新の主要ケースを固定した。
- 2026-03-28: `src/HomeApp.tsx` の provider settings handler を helper 呼び出しへ置き換えた。
- 2026-03-28: `node --test --import tsx scripts/tests/home-settings-draft.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/settings-catalog-service.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts` と `npm run build` を実行し、通過を確認した。
- 2026-03-28: コミット `0cf1148` `refactor(settings): extract catalog and draft helpers`
  - `home-settings-draft` を追加
  - `HomeApp` の provider settings handler を pure helper 経由に置き換えた
