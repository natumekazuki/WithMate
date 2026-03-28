# Plan

## 目的

- character の保存ディレクトリを workspace にした `character update session` の導線を追加する
- Character Memory を貼り付け用テキストへ整形する helper を追加する
- Character Editor から専用 window を開けるようにする

## スコープ

- character directory を workspace に使う update session 仕様
- provider ごとの instruction file 生成
- Character Memory extract の仕様と UI
- Character Editor からの起動導線

## 非スコープ

- `character.md` の自動更新
- web / wiki 調査 agent の自動実行
- Character Memory の新しい抽出ロジック

## 実装順

1. design doc と shared type を追加する
2. electron 側に character update workspace service と IPC を追加する
3. Character update window を追加し、Character Editor から開けるようにする
4. テストと docs を更新する
