# Worklog

## 2026-03-22

- `docs/design/coding-agent-capability-matrix.md` を基準に、Copilot 対応の rollout 順序を整理した
- capability ごとに follow-up task を切る方針を決めた
- Milestone A / B / C / Deferred の順で着手順を固定した
- follow-up task `20260322-copilot-basic-turn-execution` を切り、`基本 turn 実行` を完了した
- 実装の過程で `assistant text streaming` も同じ slice へ取り込み、Copilot でも current Session UI の live text 表示が通る状態にした

## Next

- 次の follow-up task は `session 継続 / cancel / audit parity` まわりの整理
- `session 再開`、`cancel / interrupted handling`、`audit log` の dedicated validation を次に切る
