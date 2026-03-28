# 20260329 IPC Boundary Test Hardening Decisions

## 初期判断

- 先に挙動変更ではなく test の追加に寄せる
- channel 名そのものより、domain ごとの registration / expose のまとまりを固定する
- `withmate-window-api` の public shape を起点に preload / main registration を確認する
