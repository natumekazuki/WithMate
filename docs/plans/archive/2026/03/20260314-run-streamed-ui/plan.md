# Plan

- Codex SDK の `runStreamed()` を Main Process から利用する
- stream イベントを IPC で Session Window へ中継する
- Session Window に実行中の live activity / streaming response 表示を追加する
- 完了時は既存の session 永続化・audit log に確定値を書き込む
- design docs を同期し、typecheck/build を通す
