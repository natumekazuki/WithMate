# Decisions

## status

- 進行中

## decision log

- pending item は `approvalRequest` の拡張ではなく `elicitationRequest` を別枠で持つ
- schema は SDK が公開している field shape のうち current surface をそのまま保持し、renderer で入力 UI へ変換する
- runtime 側の待機は approval と同様に service 層で管理し、abort 時は `cancel` を返す
- `session.rpc.ui.elicitation` の request payload は SDK type と comment が一致していないため、`{ requestId, result }` と `{ requestId, action, content }` の順で fallback 送信する
