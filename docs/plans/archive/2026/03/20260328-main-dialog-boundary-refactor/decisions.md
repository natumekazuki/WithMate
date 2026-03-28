# Decisions

- この slice は BrowserWindow 生成ではなく、dialog I/O helper の service 分離に絞る
- `pickDirectory / pickFile / pickImageFile` と `model catalog import-export` で共通化できる open/save dialog を `WindowDialogService` に寄せる
