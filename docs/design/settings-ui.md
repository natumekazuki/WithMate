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
- current 実装では `System Prompt Prefix`、`Coding Agent Providers`、`Coding Agent Credentials`、`Memory Extraction`、`Character Reflection`、`Model Catalog`、`Danger Zone` を置く
- 現在の provider / credential 設定は coding plane 専用として扱うが、current v1 の Character Reflection backend は同じ provider client を流用する
- 初回リリース前のため後方互換性は考慮しない。非互換変更が入った場合は Settings の `DB を初期化` で回復する運用を正本とする
- `DB を初期化` は `sessions / audit logs / app settings / model catalog / project memory / character memory` から対象を選べるようにし、`characters` は保持する
- `sessions` を選んだ場合は、外部キー整合のため `audit logs` も同時に初期化する
- 全対象を選んだ場合は DB ファイルを再生成して schema も初期化する
- `Settings Window` は縦方向の余白を少し増やしつつ、内容が増えた場合は window 内スクロールで末尾まで操作できるようにする
- file picker / save dialog は Main Process 側で開く
- current 実装では Main Process 側の settings / catalog 更新は `src-electron/settings-catalog-service.ts` に寄せ、renderer 側の provider row 組み立ては `src/home-settings-view-model.ts` に寄せる

## Interaction

1. ユーザーが Home toolbar の `Settings` を押す
2. 独立した `Settings Window` が開く
3. `System Prompt Prefix`、coding provider の enable / disable、coding credential、memory extraction 設定を編集して保存する。window が小さいときは内部スクロールで下端まで移動し、`Import Models` / `Export Models` / `DB を初期化` も実行できる
4. `DB を初期化` 実行前には confirm を出し、選択中の対象と非対象を明示する
5. 結果は window 内の短いフィードバックで返す
6. `Close` で `Settings Window` を閉じる

## Layout

- Home toolbar
  - `Settings`
  - `Add Character`
  - `New Session`
- Settings Window
  - `Close`
  - `System Prompt Prefix`
  - `# System Prompt` 自動付与の案内
  - `Coding Agent Providers`
    - provider 名を左、enable checkbox を右に置いた 1 行 row
  - `Coding Agent Credentials`
    - provider label を維持した credential card
    - `OpenAI API Key (Coding Agent)` 入力
    - `Character Stream 用ではない` 補助文
    - future で Character Stream 用 API 欄を別責務で追加する note
- `Memory Extraction`
  - provider ごとの `Model`
  - provider ごとの `Reasoning Depth`
  - provider ごとの `Output Tokens Threshold`
  - 現在は turn 完了時の threshold 判定と `Session Window` close 時の強制実行に使う
  - `Character Reflection`
    - provider ごとの `Model`
    - provider ごとの `Reasoning Depth`
    - trigger 条件は app 側の仕様で固定し、Settings には出さない
  - `Model Catalog`
    - import / export
    - DB 初期化時は bundled catalog へ戻る補助文
  - `Danger Zone`
    - `DB を初期化`
    - reset 対象の checkbox 群
    - reset 対象 / 非対象の説明
    - confirm
  - `Save Settings`
  - 結果フィードバック

## Current Scope

- `System Prompt Prefix` の編集と保存
- coding provider ごとの enable / disable
- coding provider ごとの `OpenAI API Key (Coding Agent)` 入力保存
- provider ごとの `Memory Extraction model / reasoning depth / outputTokens threshold` 入力保存
- provider ごとの `Character Reflection model / reasoning depth` 入力保存
- `model catalog` の import
- `model catalog` の export
- `DB を初期化` による設定・セッション系ストレージのリカバリ
  - 全選択時は DB 再生成
  - 部分選択時は対象 storage だけ reset

## Runtime Policy

- 有効化済み provider は、実行時にエラーが出るまでは利用可能前提で扱う
- current milestone では provider readiness / preflight を must-have にしない
- coding credential は Settings 保存後すぐ Main Process から各 window へ broadcast し、Session Window の実行可否表示も即時更新する
- provider 実装は保存済み coding credential を runtime の SDK client へ渡し、空文字のときだけ従来どおり環境依存 fallback を許可する
- Memory extraction 設定は provider ごとに保持し、trigger engine は現在 provider の `model / reasoning depth / outputTokens threshold` を参照する
- current 実装では、memory extraction の通常発火は `outputTokens threshold` だけで判定する
- Character reflection 設定は provider ごとに保持し、current v1 の `character reflection cycle` 実行時に `model / reasoning depth` を参照する
- Main Process 側の `app settings` 更新、`model catalog` import、rollback、関連 session / telemetry invalidation は `SettingsCatalogService` が担当する
- `DB を初期化` の partial reset / full reset orchestration と `model catalog export` の document 取得も `SettingsCatalogService` が担当する
- renderer 側では `HomeApp.tsx` が storage 正規化を直接持たず、`home-settings-view-model` の derived data を使って provider row を描画する
- renderer 側の provider settings draft 更新は `home-settings-draft` の pure function を経由する
- DB reset 成功時は renderer 側で reset 後の `appSettings` を draft に同期し、dirty 状態を解消する
- reset 実行 API は選択対象を Main Process へ渡し、戻り値の current `sessions / appSettings / modelCatalog` で renderer を再同期する

## Future Scope

- Character Stream / monologue 用 API 設定
- 新規 workspace の root directory 設定
- provider ごとの既定値
- Memory extraction の trigger mode 切替

## Non Goals

- Home に設定項目を常設すること
- Character Stream 用設定欄を current milestone で追加すること
