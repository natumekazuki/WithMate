# Decisions

- Memory 更新は coding plane とは別の extraction plane として扱う
- extraction は専用モデルに固定 prompt を投げる形を基本とする
- 返答は JSON として validate できた時だけ Memory へ保存する
- model は将来 Settings で切り替えられる余地を残すが、最初は内部既定値でよい
