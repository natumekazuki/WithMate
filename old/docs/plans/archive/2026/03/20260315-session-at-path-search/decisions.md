# Decisions

## 現時点の決定

- 対象は workspace 内の file path に限定する
- マッチ条件は relative path に対する部分一致とする
- 初版の選択操作はクリックを正本にする
- 候補一覧は textarea 直下に表示する
- picker で選んだ file / folder / image も textarea に `@path` を挿入する
- 添付解決の正本は `pickerAttachments` のような別 state ではなく textarea の `@path` とする
- image は textarea に `@path` が残っている場合にだけ `local_image` として送る
