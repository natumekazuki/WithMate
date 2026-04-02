# Decisions

## 2026-04-02

- `SessionStart` 独り言は、前回 reflection checkpoint 以降に user / assistant 会話量が増えていない場合は skip する
- `Session Window` close 時の自動 `Session Memory extraction` は削除する
- `Session Memory extraction` は Session UI の手動ボタンから `force` 実行できるようにする
- 独り言 API 分離は pending のまま据え置く
