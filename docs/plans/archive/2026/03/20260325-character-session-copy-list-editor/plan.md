# 20260325 character-session-copy-list-editor

## Goal

- Character Editor の `Session Copy` を multiline textarea ではなく候補行のリスト編集 UI に変える
- `+` ボタンで候補行を追加できるようにする

## Scope

- `Session Copy` タブの入力 UI を 1 行 input のリストへ変更
- 候補の追加と削除をできるようにする
- 既存の `string[]` 保存形式は維持する
- docs と manual test を同期する

## Out Of Scope

- SessionWindow 側の選択ロジック変更
- provider prompt への反映
- weighted random や条件付き copy

## Steps

1. `Session Copy` editor の入力 UI を候補行リストへ置き換える
2. `+` で行追加、`×` で行削除できるようにする
3. docs と manual test を更新して build で確認する
