# 20260404 chat-details-icon

## 目的

- assistant bubble 内の `Details` 導線が 1 行を占有しないようにする
- message 所属の操作だと分かる位置を保ちつつ、視線ノイズを減らす

## 対応

- artifact 展開導線を bubble 右上の小さい icon button へ置き換える
- `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` を新しい導線に合わせて更新する
- build で renderer / electron の型崩れがないことを確認する
