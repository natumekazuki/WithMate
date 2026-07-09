# Decisions

## 2026-04-24

- `WorkspaceSnapshotIndex` は process memory 上の cache とし、永続化しない。
- 初回または invalidation 時は full rebuild する。
- directory mtime / ignore file 状態が変わっていない場合は snapshot 本文を再利用し、候補ファイルだけ再読込する。
- `command_execution` / `mcp_tool_call` がある場合も、index validation が成功すれば full content scan ではなく incremental refresh を試みる。
- `.gitignore` / `.git/info/exclude` / 外部親 ignore 候補の状態が変わった場合は full rebuild する。
