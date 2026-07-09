# 20260402-monologue-threshold-settings

## 目的

- 独り言の `context-growth` trigger 条件を固定値ではなく app settings から調整できるようにする
- `session-start` の「前回独り言より会話が新しい時だけ発火」は現行のまま維持する

## スコープ

- `AppSettings` に独り言 trigger 閾値を追加する
- Settings Window から閾値を編集できるようにする
- `character-reflection` の trigger 判定が設定値を参照するようにする
- 関連テストと design doc を更新する

## 非スコープ

- 独り言 API plane の分離
- `session-start` 判定ロジックの変更
- trigger 条件そのものの再設計

## チェックポイント

1. 設定モデルと永続化の追加
2. Settings UI と draft 更新経路の追加
3. trigger 判定の settings 参照化
4. tests / docs 更新と検証
