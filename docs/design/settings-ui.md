# Settings UI

- 作成日: 2026-03-14
- 対象: `Home Window` 上で開く Settings overlay

## Goal

設定系の要素を `Home Window` に常設せず、必要なときだけ開く overlay としてまとめる。
`Session Window` を増やさずに将来の設定追加先を確保しつつ、Home の session / character 管理ハブとしての役割を崩さない。

## Decision

- 設定は独立 window ではなく `Home Window` 上の overlay とする
- overlay は一時的に開いて閉じる管理面として扱う
- 初期実装では `Model Catalog` の import / export だけを置く
- file picker / save dialog は Main Process 側で開く

## Interaction

1. ユーザーが Home toolbar の `Settings` を押す
2. Home の上に overlay が開く
3. `Import Models` または `Export Models` を実行する
4. 結果は overlay 内の短いフィードバックで返す
5. `Close` で overlay を閉じる

## Layout

- Home toolbar
  - `Settings`
  - `Add Character`
  - `New Session`
- Settings overlay
  - `Close`
  - `Import Models`
  - `Export Models`
  - 結果フィードバック

## Current Scope

- `model catalog` の import
- `model catalog` の export

## Future Scope

- monologue 用 API 設定
- 新規 workspace の root directory 設定
- provider ごとの既定値

## Non Goals

- Settings を独立 window として増やすこと
- Home に設定項目を常設すること
