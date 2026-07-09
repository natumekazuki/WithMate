# Decisions

## D-001 Characters 検索は launch dialog と同じ一致条件を使う

- `name` と `description` を対象に `includes` で検索する
- 実装は launch dialog 側の filtering helper を再利用する

## D-002 empty state は helper で確定する

- `no-match` と `empty` を helper で切り分ける
- renderer 側は helper の結果に従って描画する
