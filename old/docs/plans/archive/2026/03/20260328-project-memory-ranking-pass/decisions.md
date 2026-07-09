# Decisions

## D-001 今回は lexical retrieval の質だけを上げる

- `#14` の時間減衰とは分離する
- current retrieval の query / tokenization 方針は維持する

## D-002 ranking は 3 点強化に絞る

- minimum score threshold
- query coverage bonus
- duplicate suppression

## D-003 設定画面は増やさない

- threshold は internal rule とする
- user-facing setting はまだ追加しない
