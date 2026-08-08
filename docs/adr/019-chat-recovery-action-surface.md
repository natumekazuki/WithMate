# 019 Chat Recovery Action Surface

- 状態: Accepted
- 日付: 2026-08-09

## Context

失敗、中断、キャンセル後の retry UI は Action Dock の expanded composer 内にあり、表示時に dock を強制展開していた。banner には停止地点と前回の依頼も複製されていたが、停止地点は直前の chat response、依頼は user message から確認できる。情報の重複により中央領域と composer の高さが圧迫され、file preview 中や狭い Window では回復操作を見つけにくかった。

回復操作は Agent Session と Companion の両方で必要であり、個別 layout や mode 固有の配置を増やさず、中央 preview と Action Dock の状態から独立して到達できる必要がある。

## Decision

- recovery action surface の canonical owner は共通 `ChatWindow` の message stack とする
- surface は中央の chat または file preview の直下、Action Dock の直上へ配置する
- 表示内容は状態 badge、短い title、`同じ依頼を再送`、`編集して再送`、必要時の draft 置換確認に限定する
- 停止地点、前回の依頼、`Details`、`Hide` は表示しない。詳細は chat transcript を正本とする
- recovery action surface の有無は Action Dock の expanded / compact state を変更しない
- Agent Session と Companion は同じ component と配置を使い、中央 preview 表示中も回復操作を残す
- 狭い Window では内容と操作を折り返し、横 overflow を発生させない
- surface 自体へ自動 focus は移さない。`編集して再送` の実行時だけ既存どおり composer textarea へ focus を移す
- terminal state が解消した場合は surface を消す。ユーザーが任意に隠す state と再表示操作は持たない

## Alternatives

- Action Dock 内に残す: compact state と両立せず、composer の責務に run recovery を混在させるため採用しない
- terminal assistant message 内へ埋め込む: message virtualization と transcript persistence に一時的な操作 state を結合し、preview 中の到達性も失うため採用しない

## Consequences

### Positive

- chat と composer の高さを重複情報に使わず、回復操作だけを常時見つけられる
- Action Dock の開閉をユーザーの選択として維持できる
- Agent Session、Companion、中央 preview で配置と操作感が揃う

### Negative

- 原因や元の依頼を確認するには chat transcript を読む必要がある
- transcript が読み返し位置にある場合、回復操作と参照箇所が同時に見えないことがある
