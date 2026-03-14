# Result
# Result

- `CodexAdapter` を `thread.runStreamed()` ベースへ切り替えた
- Main Process が session ごとの live state を保持し、IPC で Session Window へ中継するようにした
- Session Window の pending bubble に assistant text と live activity step を逐次表示するようにした
- 監査ログと session 永続化は turn 完了後の確定値のみを保存する方針に揃えた
- 進行中
