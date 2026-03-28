# Plan

## 目的

- Character Editor の白画面を解消する
- Settings Window で保存済み設定が反映される前に default が見える問題を解消する

## スコープ

- character clone の欠落修正
- settings ready 判定の修正
- 関連 unit test の追加

## 非スコープ

- UI 文言変更
- 新機能追加

## 実装順

1. 原因箇所を修正する
2. unit test を追加・更新する
3. build と関連 test で回帰確認する
