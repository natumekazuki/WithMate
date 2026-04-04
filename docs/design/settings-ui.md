# Settings UI

- 作成日: 2026-03-14
- 対象: 独立した `Settings Window`

## Goal

設定系の要素を `Home Window` から分離し、独立した `Settings Window` に集約する。
`Home Window` は session / character 管理ハブへ寄せ、設定編集は別 window で落ち着いて扱えるようにする。

## Decision

- 設定は `Home Window` から開く独立 `Settings Window` とする
- `System Prompt Prefix` は `Settings Window` で定義し、prompt composition に渡す
- `System Prompt Prefix` は保存時に `# System Prompt` 配下へ組み込まれる
- `Memory Generation` は global toggle とし、OFF 時は Session Memory extraction / Character Reflection / Monologue の background 実行をまとめて止める
- current 実装では `System Prompt Prefix`、`Session Window`、`Coding Agent Providers`、`Skill Roots`、`Memory Extraction`、`Character Reflection`、`Model Catalog` を置く
- `Settings Window` は縦方向の余白を少し増やしつつ、内容が増えた場合は window 内スクロールで末尾まで操作できるようにする
- file picker / save dialog は Main Process 側で開く
- current 実装では Main Process 側の settings / catalog 更新は `src-electron/settings-catalog-service.ts` に寄せ、renderer 側の provider row 組み立ては `src/home-settings-view-model.ts` に寄せる

## Interaction

1. ユーザーが Home toolbar の `Settings` を押す
2. 独立した `Settings Window` が開く
3. `System Prompt Prefix`、Session 表示設定、coding provider の enable / disable、skill root、memory extraction / character reflection 設定を編集して保存する。window が小さいときは内部スクロールで下端まで移動し、`Import Models` / `Export Models` も実行できる
4. 結果は window 内の短いフィードバックで返す

## Layout

- Home toolbar
  - `Settings`
  - `Add Character`
  - `New Session`
- Settings Window
  - `System Prompt Prefix`
  - `# System Prompt` 自動付与の案内
  - `Session Window`
    - `送信後に Action Dock を自動で閉じる`
  - `Coding Agent Providers`
    - provider 名を左、enable checkbox を右に置いた 1 行 row
  - `Skill Roots`
    - provider ごとの skill root path
    - `Browse`
- `Memory Extraction`
  - `Memory Generation` global toggle
  - provider ごとの `Model`
  - provider ごとの `Reasoning Depth`
  - provider ごとの `Output Tokens Threshold`
  - provider ごとの `Timeout Seconds`
  - `Character Reflection`
    - app-wide の `Cooldown Seconds` / `Min Char Delta` / `Min Message Delta`
    - provider ごとの `Model`
    - provider ごとの `Reasoning Depth`
    - provider ごとの `Timeout Seconds`
  - `Model Catalog`
    - import / export
  - `Save Settings`
  - 結果フィードバック

## Current Scope

- `System Prompt Prefix` の編集と保存
- `Session Window` の `送信後に Action Dock を自動で閉じる` の保存
- coding provider ごとの enable / disable
- coding provider ごとの `Skill Root` 入力保存
- provider ごとの `Memory Extraction model / reasoning depth / outputTokens threshold / timeout` 入力保存
- provider ごとの `Character Reflection model / reasoning depth / timeout` 入力保存
- app-wide の `Character Reflection` trigger 設定の保存
- `Memory Generation` global toggle の入力保存
- `model catalog` の import
- `model catalog` の export

## Runtime Policy

- `Memory Generation` が OFF の時は、Session Memory extraction / Character Reflection / Monologue の background 実行をまとめて止める
- Memory extraction 設定は provider ごとに保持し、trigger engine は現在 provider の `model / reasoning depth / outputTokens threshold / timeout` を参照する
- current 実装では、memory extraction の通常発火は `outputTokens threshold` だけで判定する
- Character reflection 設定は provider ごとに保持し、current v1 の `character reflection cycle` 実行時に `model / reasoning depth / timeout` を参照する
- Main Process 側の `app settings` 更新、`model catalog` import、rollback、関連 session / telemetry invalidation は `SettingsCatalogService` が担当する
- `model catalog export` の document 取得も `SettingsCatalogService` が担当する
- renderer 側では `HomeApp.tsx` が storage 正規化を直接持たず、`home-settings-view-model` の derived data を使って provider row を描画する
- renderer 側の provider settings draft 更新は `home-settings-draft` の pure function を経由する
- `HomeApp.tsx` は `systemPromptPrefix` と 3 種の provider settings を別 state で持たず、単一の `AppSettings draft` を編集する
- save 時の payload は `home-settings-view-model` が resolved model / reasoning を反映した `persisted settings` として組み立てる
- Settings Window の `loading` 派生状態は `HomeApp.tsx` が組み立てる
- Settings Window の `import / export / save` の文言組み立てと戻り値解釈は `home-settings-actions` が担当する
- Settings 保存成功時は renderer 側で戻り値の `appSettings` を draft に同期し、dirty 状態を解消する

## Future Scope

- 独立 monologue plane 用 API 設定
- 新規 workspace の root directory 設定
- provider ごとの既定値
- Memory extraction の trigger mode 切替

## Non Goals

- Home に設定項目を常設すること
- 独立 monologue plane 用設定欄を current milestone で追加すること
