# Result

- 状態: 完了
- Settings に `Memory Generation` global toggle を追加した
- OFF 時は Session Memory extraction / Character Reflection / Monologue の background 実行をまとめて止めるようにした
- provider ごとの model / reasoning / threshold は保持し、再度 ON にした時にそのまま使う
- 検証:
  - `npm run build`
  - `node --test --import tsx scripts/tests/app-settings-storage.test.ts scripts/tests/settings-ui.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/home-settings-draft.test.ts scripts/tests/memory-orchestration-service.test.ts`
- 対応コミット:
  - `d9f8014` `feat(settings): add memory generation toggle`
