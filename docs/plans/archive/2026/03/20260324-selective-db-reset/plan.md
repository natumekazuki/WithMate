# 20260324 selective-db-reset

## Goal

- Settings の `DB を初期化` で、初期化対象を選べるようにする
- `sessions / audit logs / app settings / model catalog` を個別に初期化できるようにする
- 全対象を選んだときは DB ファイルを再生成して schema も初期化する

## Scope

- reset IPC contract の拡張
- Main Process の reset 実装更新
- Home Settings の Danger Zone UI 更新
- 最低限の docs / tests 更新

## Out Of Scope

- characters の reset
- legacy schema の後方互換
- Session Window 側の reset UI

## Steps

1. reset API と選択対象の型を追加する
2. 全選択時の DB 再生成と部分 reset を実装する
3. Danger Zone を選択式 UI に更新する
4. docs と tests を更新して検証する
