# Decisions

- Settings は `Home Window` 上の overlay ではなく独立 `Settings Window` として扱う
- `Memory Extraction` の provider 設定は `codingProviderSettings` と分離して持つ
- current milestone では provider ごとの設定項目を `model`、`reasoning depth`、`outputTokens threshold` に限定する
- Settings 画面の複雑化を避けるため、統計表示や auto mode は追加しない
