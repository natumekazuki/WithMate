# 結果

- 状態: 完了

## 実装

- `Character Editor` の `Open Update Workspace` は専用 window を開かず、editor 内の provider picker modal から `character-update` session を直接作成する
- `sessionKind === "character-update"` の session は `SessionWindow` の variant として描画する
- variant では
  - header から `Terminal / More` を外す
  - right pane を `LatestCommand / MemoryExtract` に切り替える
  - composer の `Skill / Agent` picker を外す
- 旧 `Character Update Window` 専用の IPC / preload / window routing は削除した

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/preload-api.test.ts scripts/tests/main-window-facade.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-ipc-registration.test.ts scripts/tests/aux-window-service.test.ts scripts/tests/window-entry-loader.test.ts scripts/tests/session-storage.test.ts`
