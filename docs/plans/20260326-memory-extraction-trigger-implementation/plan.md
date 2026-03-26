# Plan

- status: in_progress
- goal: provider ごとの outputTokens threshold を使って Session Memory extraction の裏処理を発火できるようにする。
- scope:
  - Settings で保存している memory extraction 設定を trigger 判定に使う
  - SessionMemoryDelta の validate / merge を実装する
  - session close 前の強制実行経路を用意する
- out_of_scope:
  - Project Memory / Character Memory への昇格
  - 統計表示や自動 threshold 算出
  - compact 前の強制 trigger
