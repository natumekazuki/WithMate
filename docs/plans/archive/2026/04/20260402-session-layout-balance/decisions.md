# Decisions

## D-001

- 状態: 採用
- 決定: wide レイアウトでは `左列 = message list + Action Dock`、`右列 = context pane` の 2 カラムに組み替える
- 理由: Action Dock の幅を会話列へ揃えつつ、right pane を下端まで伸ばせるため

## D-002

- 状態: 採用
- 決定: 1400px 以下では `message list + Action Dock` の塊を上段、right pane を下段に置く 1 カラム stack へ切り替える
- 理由: right pane を見失わず、送信 UI と会話本文の近接も保ちやすいため
