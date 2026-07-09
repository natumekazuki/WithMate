# Decisions

## Decision 1

- status: confirmed
- decision: user 合意前は調査のみ行い、実装変更は保留する
- rationale:
  - 今回は先に原因と修正案を共有してから進める依頼のため

## Decision 2

- status: confirmed
- decision: `Copilot` の stale session retry は「completed 済み command だけを partial blocker にする」方針で修正する
- rationale:
  - `tool.execution_start` や pending permission は user-visible な確定結果ではなく、ここで retry を止めると stale cached session recovery が過剰に失敗扱いになる
  - completed / failed / canceled の command だけを `operations` へ残せば、監査ログの確定値と retry blocker の意味を揃えられる
