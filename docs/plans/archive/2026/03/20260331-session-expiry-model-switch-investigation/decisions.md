# Decisions

## 2026-03-31

### `#24` と `#32` は同一クラスタで扱う

- `#24` は model switch を契機に見えても、current 実装では model / reasoningEffort 更新時に `threadId` を維持する
- `#32` も long-idle 後に同じ `threadId` を使って resume しに行く
- どちらも「stale / 失効 / 非互換になった provider session thread を reuse して失敗する」クラスタとして扱うのが妥当
- ただし `#24` には Codex の model-switch resume 非互換が上乗せされる可能性があるため、基準ケースの `#32` とは実測で切り分ける

### 実装は follow-up に分離する

- 今回の task は原因仮説整理と対応方針決定までに留める
- adapter recovery、thread reset policy、telemetry 強化は別実装 task として切り出す
- これにより `same-plan` で調査と実装を混在させず、review と検証の単位を保てる

### 先に error taxonomy と recovery policy を定義する

- `NotFound / expiry / invalid-thread / model-incompatible` を同じ失敗文面のまま扱うと、`#24` と `#32` の差分が観測できない
- provider ごとの model switch policy を決める前に、stale `threadId` を無効化して新規 session / thread へ回復する共通方針を置く
- 暫定安全策としては「model switch 時 reset」を両 provider へ広げる案もあるが、まず taxonomy を先に置く

### questions status は `質問なし` とする

- 追加ヒアリングがなくても調査結果の整理と方針決定は可能
- 未確認事項は `questions.md` の Optional Follow-Up Questions に残し、後続実測で回収する
