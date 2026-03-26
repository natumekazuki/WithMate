# Plan

- 作成日: 2026-03-26
- タスク: Settings Window 初期表示で default state が見える問題を修正する

## Goal

- `Settings Window` を開いた直後に保存済み設定が失われたように見えないようにする
- `appSettings` と `modelCatalog` の取得完了までは loading state を表示する

## Steps

- [ ] 初期表示の原因を確認する
- [ ] loading gate を追加する
- [ ] build で回帰確認する
