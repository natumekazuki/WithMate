# Questions

## Status

- 質問なし

## 理由

- 対象範囲は「stale thread / session 起因エラーへの最小安全版 reset + internal retry」に絞れている
- same-plan / new-plan の境界も、stale-thread classifier・internal retry・pre-send reset と、transport/general retry 系 follow-up で整理できている

## Optional Follow-Up Questions

- stale 判定 message / error code を provider ごとにどこまで揃えられるか
- `partial result 実質なし` を turn event / audit 上でどの値で固定するか
- model switch の reset を Codex / Copilot で完全共通化するか、provider 差分を残すか
