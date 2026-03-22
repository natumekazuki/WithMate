# Decisions

## 2026-03-23

- Copilot provider の recovery は SDK patch ではなく WithMate adapter 側で行う
- `Connection is closed.` と `CLI server exited ... code 0` は stale connection 系として 1 回だけ retry 対象にする
