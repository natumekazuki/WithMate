# Settings UI

- 作成日: 2026-03-14
- 更新日: 2026-04-27
- 対象: 独立した `Settings Window`

## Goal

設定系の要素を `Home Window` から分離し、独立した `Settings Window` に集約する。
`Home Window` は session / character 管理ハブへ寄せ、設定編集は別 window で落ち着いて扱えるようにする。

## Decision

- 設定は `Home Window` から開く独立 `Settings Window` とする
- `System Prompt Prefix` は `Settings Window` で定義し、prompt composition に渡す
- `System Prompt Prefix` は保存時に `# System Prompt` 配下へ組み込まれる
- `Memory Generation` / `Memory Extraction` / `Character Reflection` は current UI から削除する
- current 実装では `System Prompt Prefix`、`Session Window`、`Coding Agent Providers`、`Skill Roots`、`Model Catalog` を置く
- `Settings Window` は縦方向の余白を少し増やしつつ、内容が増えた場合は window 内スクロールで末尾まで操作できるようにする
- file picker / save dialog は Main Process 側で開く
- current 実装では Main Process 側の settings / catalog 更新は `src-electron/settings-catalog-service.ts` に寄せ、renderer 側の provider row 組み立ては `src/home-settings-view-model.ts` に寄せる

## Interaction

1. ユーザーが Home toolbar の `Settings` を押す
2. 独立した `Settings Window` が開く
3. `System Prompt Prefix`、Session 表示設定、coding provider の enable / disable、skill root を編集して保存する。window が小さいときは内部スクロールで下端まで移動し、`Import Models` / `Export Models` も実行できる
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
  - current UI では表示しない
- `Character Reflection`
  - current UI では表示しない
- `Model Catalog`
  - import / export
- `Save Settings`
- 結果フィードバック

## Current Scope

- `System Prompt Prefix` の編集と保存
- `Session Window` の `送信後に Action Dock を自動で閉じる` の保存
- coding provider ごとの enable / disable
- coding provider ごとの `Skill Root` 入力保存
- `model catalog` の import
- `model catalog` の export

## Runtime Policy

- MemoryGeneration / Character Reflection / Monologue の background 実行は current runtime では行わない
- Memory extraction / Character reflection の既存 settings key は互換用に残る場合があるが、current UI では編集面を出さない
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
- MemoryGeneration を再設計する場合の専用設定

## Non Goals

- Home に設定項目を常設すること
- 独立 monologue plane 用設定欄を current milestone で追加すること
- MemoryGeneration / Character Reflection の旧設定 UI を current milestone で維持すること
