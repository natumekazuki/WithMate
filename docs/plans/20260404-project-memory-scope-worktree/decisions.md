# Decisions

## Decision 1

- status: confirmed
- decision: `Project Memory` の内部識別子は `gitRemoteUrl` を最優先し、取れない時は repository identity、最後に `gitRoot` を使う
- rationale:
  - `git worktree` では worktree ルートごとに `.git` file があるため、`gitRoot` を key にすると同一 repository でも scope が分かれてしまう
  - `repo 名` は表示には向くが key としては衝突しやすいため、内部識別子には使わない

