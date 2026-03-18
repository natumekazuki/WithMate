# Worklog

## Timeline

### 0001

- 日時: 2026-03-18
- チェックポイント: current policy の再固定
- 実施内容:
  - legacy fallback 維持前提を plan docs から外し、canonical-only + DB reset recovery 方針へ整理した
  - docs / tests / UI / IPC の対象ファイルを current state ベースで棚卸しした
- 検証:
  - 実装前計画のみのため未実施

### 0002

- 日時: 2026-03-18
- チェックポイント: Settings overlay / reset state sync の completion
- 実施内容:
  - `src/HomeApp.tsx` で reset confirm と success wording を定数利用へ寄せ、`sessions / appSettings / modelCatalog` を reset result へ同期するよう確認した
  - reset 成功後に `applyIncomingAppSettings(..., { force: true })` で draft を reset 後状態へ同期し、dirty 解消を担保した
  - running session による reset 拒否エラーは renderer でそのまま表示する動線を維持した
  - `src-electron/main.ts` の reset 戻り値型を `ResetAppDatabaseResult` へ揃えた
- 検証:
  - 実装後に targeted tests / typecheck / build を実施

### 0003

- 日時: 2026-03-18
- チェックポイント: tests / docs / plan docs sync
- 実施内容:
  - `scripts/tests/app-settings-storage.test.ts` を canonical-only 前提へ更新し、`resetSettings()` の既定値復帰を確認するようにした
  - `scripts/tests/model-catalog-settings.test.ts` を canonical `codingProviderSettings` 正本前提へ揃えた
  - `scripts/tests/settings-ui.test.ts` に reset wording / helper / confirm / success の期待値を追加した
  - `README.md`、design docs、manual checklist、`docs/要件定義_叩き.md`、plan docs を current milestone と DB reset 方針へ同期した
- 検証:
  - `node --test --import tsx scripts/tests/settings-ui.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/app-settings-storage.test.ts`
  - `npm run typecheck`
  - `npm run build`

### 0004

- 日時: 2026-03-19
- チェックポイント: validation 再確認と archive 準備
- 実施内容:
  - plan 完了条件に対して差分と validation を再確認し、archive 対象として閉じられる状態であることを確認した
  - `scripts/tests/session-storage.test.ts` と `src-electron/session-storage.ts` の session 全削除対応も reset 後同期の一部として含まれていることを確認した
- 検証:
  - `node --test --import tsx scripts/tests/settings-ui.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/app-settings-storage.test.ts`
  - `npm run typecheck`
  - `npm run build`
- 関連コミット: 未作成

## Open Items

- なし
