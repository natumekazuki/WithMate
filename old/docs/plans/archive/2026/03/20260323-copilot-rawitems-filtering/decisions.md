# Decisions

## 2026-03-23

- Audit Log の `rawItemsJson` は packet dump ではなく、監査で読む stable event trace として扱う
- `*_delta` と `ephemeral: true` は原則 drop 候補にする
- bootstrap failure 時の `copilot_bootstrap_debug` は filtered trace とは別にそのまま残す
