# Plan

- 作成日: 2026-03-26
- タスク: Settings を別ウインドウへ切り出し、Memory Extraction の provider 設定を追加する

## Goal

- `Home Window` の Settings overlay を独立 `Settings Window` へ切り出す
- `AppSettings` に Memory Extraction 用の provider 設定を追加する
- provider ごとに `model`、`reasoning depth`、`outputTokens threshold` を保存できるようにする

## Scope

- `Settings Window` の起動導線追加
- `Settings Window` の renderer mode 追加
- `AppSettings` / storage / IPC の更新
- Memory Extraction 設定 UI 追加
- design / manual test / plan 更新

## Out of Scope

- Memory extraction 実行そのもの
- extraction trigger engine
- Project / Character Memory の retrieval 実装

## Steps

- [ ] `Settings Window` 化の方針を反映する
- [ ] `AppSettings` に Memory Extraction 設定を追加する
- [ ] Settings UI を更新する
- [ ] docs と tests を更新する

## Verification

- `npm run build`
- `node --test --import tsx scripts/tests/app-settings-storage.test.ts scripts/tests/settings-ui.test.ts`
