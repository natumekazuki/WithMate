# Decisions

## D-001 v1 は model / reasoning depth だけ持つ

- `Character Reflection` の settings はまず `model / reasoning depth` に限定する
- trigger 関連の閾値は app 側の仕様で固定し、Settings には出さない

## D-002 provider ごとに持つ

- `Memory Extraction` と同じく provider ごとの設定にする
- current reflection 実装の backend がどの provider を使うかに追従できる形を先に作る
