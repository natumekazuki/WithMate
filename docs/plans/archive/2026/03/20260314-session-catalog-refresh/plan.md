# Plan

## Goal

- model catalog を import して revision が上がった後も、既存 session から最新 catalog の model / depth を選べるようにする

## Scope

- Session Window の model catalog 参照見直し
- session の `catalogRevision` 更新タイミング見直し
- 関連 Design Doc / 実機テスト項目表の更新

## Task List

- [x] 現行の catalogRevision 固定挙動を確認する
- [x] Session Window を active catalog 追従に直す
- [x] model / depth 変更時に catalogRevision を更新する
- [x] docs とテスト項目を更新する
- [x] 検証する
