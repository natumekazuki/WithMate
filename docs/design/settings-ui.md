# Settings UI

- 作成日: 2026-03-14
- 更新日: 2026-06-21
- 対象: 独立した `Settings Window`

## Goal

設定系の要素を `Home Window` から分離し、独立した `Settings Window` に集約する。
`Home Window` は session / character 管理ハブへ寄せ、設定編集は別 window で落ち着いて扱えるようにする。

## Decision

- 設定は `Home Window` から開く独立 `Settings Window` とする
- app 共通 system prompt を編集する旧設定項目は廃止する
- V5 current では Character 定義は `Characters` editor で管理し、session / companion 開始時の `CharacterRuntimeSnapshot` を runtime prompt の主経路にする
- provider instruction sync は V5 Character 注入の主経路ではなく、Settings current UI には置かない
- current 実装では `Session Window`、`Default Microcopy`、`Coding Agent Providers`、`Diagnostics`、`Mate Reset`、`Model Catalog` を置く
- `Settings Window` は縦方向の余白を少し増やしつつ、内容が増えた場合は window 内スクロールで末尾まで操作できるようにする
- file picker / save dialog は Main Process 側で開く
- current 実装では Main Process 側の settings / catalog 更新は `src-electron/settings-catalog-service.ts` に寄せ、renderer 側の provider row 組み立ては `src/home-settings-view-model.ts` に寄せる

## Interaction

1. ユーザーが Home toolbar の `Settings` を押す
2. 独立した `Settings Window` が開く
3. Session 表示設定、microcopy、coding provider の enable / disable と provider file settings を編集して保存する。window が小さいときは内部スクロールで下端まで移動し、`Import Models` / `Export Models` も実行できる
4. 結果は window 内の短いフィードバックで返す

## Layout

- Home toolbar
  - `Settings`
  - `Add Character`
  - `New Session`
- Settings Window
  - `Session Window`
    - `送信後に Action Dock を自動で閉じる`
  - `Coding Agent Providers`
    - provider 名を左、enable checkbox を右に置く
    - provider ごとの `Provider File Settings`
      - `Root Directory`
      - `Skill Relative Path`
      - `Instruction Relative Path`
  - `Diagnostics`
    - app log / crash dump folder
  - `Mate Reset`
    - legacy Mate state reset
- `Model Catalog`
  - import / export
- `Save Settings`
- 結果フィードバック

## Current Scope

- `Session Window` の `送信後に Action Dock を自動で閉じる` の保存
- coding provider ごとの enable / disable
- coding provider ごとの provider file settings
  - `Root Directory` は provider ごとの file 設定の基準 directory として保持される
  - `Skill Relative Path` がある場合は root 配下の相対 path として解決される
  - `Instruction Relative Path` は root 配下の instruction file 設定として保持される
  - V5 current では skill folder だけが runtime の skill 探索元になり、instruction file は Provider Instruction Sync を再起動せず設定値として保持する
- Diagnostics の folder open
- legacy Mate reset
- `model catalog` の import
- `model catalog` の export

## Runtime Policy

- MemoryGeneration / Character Reflection / Monologue の background 実行は current runtime では行わない
- Memory extraction / Character reflection の既存 settings key は互換用に残る場合があるが、current UI では編集面を出さない
- Provider Instruction Sync の既存設定や table は legacy 互換として残る場合があるが、V5 Character runtime prompt の主経路ではない
- Main Process 側の `app settings` 更新、`model catalog` import、rollback、関連 session / telemetry invalidation は `SettingsCatalogService` が担当する
- `model catalog export` の document 取得も `SettingsCatalogService` が担当する
- renderer 側では `HomeApp.tsx` が storage 正規化を直接持たず、`home-settings-view-model` の derived data を使って provider row を描画する
- renderer 側の provider settings draft 更新は `home-settings-draft` の pure function を経由する
- provider file settings の directory / file picker は、`Root Directory` 配下で選ばれた path だけを相対 path として draft へ反映する
- `HomeApp.tsx` は provider settings を別 state で持たず、単一の `AppSettings draft` を編集する
- save 時の payload は `home-settings-view-model` が resolved model / reasoning を反映した `persisted settings` として組み立てる
- Settings Window の `loading` 派生状態は `HomeApp.tsx` が組み立てる
- Settings Window の `import / export / save` の文言組み立てと戻り値解釈は `home-settings-actions` が担当する
- Settings 保存成功時は renderer 側で戻り値の `appSettings` を draft に同期し、dirty 状態を解消する
- Character editor は Settings Window から分離し、Home の `Characters` panel から開く独立 `Character Editor Window` で扱う。
- `character.md` の validation error は `Character Editor Window` の raw editor 操作結果として表示する。

## Future Scope

- 独立 monologue plane 用 API 設定
- 新規 workspace の root directory 設定
- provider ごとの既定値
- MemoryGeneration を再設計する場合の専用設定
- provider instruction sync を V5 で再導入する場合の専用設定

## Non Goals

- Home に設定項目を常設すること
- 独立 monologue plane 用設定欄を current milestone で追加すること
- MemoryGeneration / Character Reflection の旧設定 UI を current milestone で維持すること
