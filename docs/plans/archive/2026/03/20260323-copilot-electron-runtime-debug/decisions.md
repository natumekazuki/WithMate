# Decisions

## 2026-03-23

- この task は `docs/plans/20260322-copilot-capability-rollout/` の follow-up として扱う
- 先に debug / trace を追加して failure point を明確にし、その後で修正有無を判断する
- 追加ログは session/client lifecycle と `session.sendAndWait()` 前後に絞る
