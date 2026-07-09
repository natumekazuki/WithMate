# Decisions

## 2026-03-31

### same-plan は最小安全版の stale reset + internal retry に閉じる

- 今回の target は stale thread / session 起因エラーへの最小安全版 recovery に限定する
- same-plan には `stale-thread classifier + internal retry` と `model / reasoningEffort` change 時の pre-send reset を含める
- transport error 一般化、partial result 後 retry、public API retry は new-plan / follow-up へ分離する

### retry は `SessionRuntimeService` 内で同一 user turn に 1 回だけ行う

- provider adapter ごとに別々の retry policy を増やすより、runtime で 1 回に固定した方が挙動を追いやすい
- user turn 境界をまたぐ再試行や public API から見える retry 制御は今回扱わない
- 既存の Copilot stale connection retry は維持するが、同じ考え方を transport error 全般には広げない

### `threadId` reset だけでは不十分で provider cache invalidate が必要

- DB 整合性は `threadId` 自体の reset では壊れにくい前提でよい
- ただし runtime / adapter 側 cache が stale session を握ったままだと、`threadId` を消しても同じ provider state を再利用してしまう
- そのため same-plan でも retry 前に provider cache invalidate を伴う reset を前提にする

### retry 条件は `partial result 実質なし` を必須にする

- 途中まで assistant text や item が見えている失敗を自動 retry すると、既存結果の重複や欠落を招きやすい
- 今回の最小安全版では「ユーザーに実質何も返っていない」失敗だけを internal retry 対象にする
- partial result 後 retry は follow-up で別設計にする

### `model / reasoningEffort` change 時の pre-send reset を same-plan に含める

- stale / incompatible thread を最も露出させやすいのが model / reasoningEffort change 後の send である
- design 上の reset 方針と runtime 実装を揃えるため、send 前 reset を same-plan の必須項目にする
- これにより stale classifier の事後 recovery だけに依存しない
