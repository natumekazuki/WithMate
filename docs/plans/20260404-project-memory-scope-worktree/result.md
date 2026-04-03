# Result

- status: completed

## Summary

- `Project Memory` の内部 key は `gitRemoteUrl` を最優先し、取れない時だけ repository identity / `gitRoot` へ fallback するようにした
- `git worktree` で保存済みの legacy scope は、現在開いている repository key へ寄せる migration を追加した
- `Project Memory` の共有単位は「worktree ルート」ではなく「repository 単位」であることを docs に同期した

## Commits

- なし
