# Settings UI

- 作成日: 2026-03-14
- 対象: `Home Window` 上で開く Settings overlay

## Goal

設定系の要素を `Home Window` に常設せず、必要なときだけ開く overlay としてまとめる。
`Session Window` を増やさずに将来の設定追加先を確保しつつ、Home の session / character 管理ハブとしての役割を崩さない。

## Decision

- 設定は独立 window ではなく `Home Window` 上の overlay とする
- overlay は一時的に開いて閉じる管理面として扱う
- `System Prompt Prefix` は Settings overlay で定義し、prompt composition に渡す
- `System Prompt Prefix` は保存時に `# System Prompt` 配下へ組み込まれる
- current 実装では `System Prompt Prefix`、provider ごとの enable / disable、API key 入力、`Model Catalog` の import / export を置く
- file picker / save dialog は Main Process 側で開く

## Interaction

1. ユーザーが Home toolbar の `Settings` を押す
2. Home の上に overlay が開く
3. `System Prompt Prefix` や provider 設定を編集して保存する、または `Import Models` / `Export Models` を実行する
4. 結果は overlay 内の短いフィードバックで返す
5. `Close` で overlay を閉じる

## Layout

- Home toolbar
  - `Settings`
  - `Add Character`
  - `New Session`
- Settings overlay
  - `Close`
  - `System Prompt Prefix`
  - `# System Prompt` 自動付与の案内
  - provider ごとの enable checkbox
  - provider ごとの API key 入力
  - `Save Settings`
  - `Import Models`
  - `Export Models`
  - 結果フィードバック

## Current Scope

- `System Prompt Prefix` の編集と保存
- provider ごとの enable / disable
- provider ごとの API key 入力保存
- `model catalog` の import
- `model catalog` の export

## Runtime Policy

- 有効化済み provider は、実行時にエラーが出るまでは利用可能前提で扱う
- current milestone では provider readiness / preflight を must-have にしない
- API key は Settings 保存後すぐ Main Process から各 window へ broadcast し、Session Window の実行可否表示も即時更新する
- provider 実装は保存済み API key を runtime の SDK client へ渡し、空文字のときだけ従来どおり環境依存 fallback を許可する

## Future Scope

- monologue 用 API 設定
- 新規 workspace の root directory 設定
- provider ごとの既定値

## Non Goals

- Settings を独立 window として増やすこと
- Home に設定項目を常設すること
