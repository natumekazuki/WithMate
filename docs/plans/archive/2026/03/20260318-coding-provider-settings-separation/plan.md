# Plan

## Goal

- Settings に見えている provider / credential を **coding plane 用設定**として明確に固定する
- current milestone の前提どおり、`Character Stream` / monologue plane は **未着手のまま維持**する
- 初回リリース前は後方互換性を考慮せず、非互換変更時は Settings の `DB を初期化` で回復する方針へ repo 全体を同期する
- 実装、tests、docs、plan docs を current state へ揃える

## Scope

- `AppSettings.codingProviderSettings` を canonical shape として扱う
- legacy `providerSettings` / `provider_settings_json` 前提を docs / tests / plan docs から除去する
- Settings overlay に `Danger Zone` の `DB を初期化` 導線を揃える
- DB reset 後に renderer state を `sessions / app settings / model catalog` へ同期し、draft dirty を解消する
- current milestone 非対象の `Character Stream` 設定欄は追加しない

## Non Goals

- Character Stream / monologue plane の実装着手
- Character Stream 用 API key / provider 設定欄の追加
- DB reset backend の全面作り直し
- 大規模な UI リファクタ

## Implementation Breakdown

### 1. Home Settings overlay の completion

- `src/HomeApp.tsx`
  - `Danger Zone` に `DB を初期化` ボタンを置く
  - confirm wording を定数化して使う
  - `window.withmate.resetAppDatabase()` の結果から `sessions / appSettings / modelCatalog` を同期する
  - reset 成功後は settings draft を reset 後 `appSettings` へ force sync し、dirty を解消する
  - running session による拒否エラーは message をそのまま表示する

### 2. IPC / main / preload contract の整合

- `src/settings-ui.ts`
  - reset label / help / confirm / success wording を一元管理する
- `src/withmate-window.ts`
  - `ResetAppDatabaseResult` を renderer が使いやすい shape のまま維持する
- `src-electron/main.ts`
  - `WITHMATE_RESET_APP_DATABASE_CHANNEL` を import し、戻り値型を contract に寄せる

### 3. tests sync

- `scripts/tests/app-settings-storage.test.ts`
  - canonical-only 前提へ更新する
  - `resetSettings()` で default に戻ることを確認する
- `scripts/tests/model-catalog-settings.test.ts`
  - canonical `codingProviderSettings` だけを正本として扱う期待値へ揃える
- `scripts/tests/settings-ui.test.ts`
  - reset wording / helper / confirm / success message の期待値を追加する

### 4. docs sync

- `README.md`
- `docs/design/settings-ui.md`
- `docs/design/provider-adapter.md`
- `docs/design/desktop-ui.md`
- `docs/design/product-direction.md`
- `docs/design/monologue-provider-policy.md`
- `docs/manual-test-checklist.md`
- `docs/要件定義_叩き.md`

各 doc で次を揃える:
- 初回リリース前は後方互換性を考慮しない
- 非互換変更時は Settings の DB reset で回復する
- 現在の provider / credential 設定は coding plane 用
- Character Stream は current milestone では未着手
- DB reset は `sessions / audit logs / app settings / model catalog` を初期化し、`characters` は保持する

## Validation

- `node --test --import tsx scripts/tests/settings-ui.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/app-settings-storage.test.ts`
- `npm run typecheck`
- `npm run build`

## Completion Criteria

- Settings overlay の reset 導線が UI / wording / state sync まで揃っている
- tests が legacy fallback 前提を持たず、canonical-only 前提で pass する
- docs / plan docs が current milestone と recovery policy に同期している
- Character Stream 用設定欄は追加されていない
