# Worklog

- 2026-04-04: plan 開始。`git worktree` で `Project Memory` が worktree 単位に分かれる挙動を repository 単位へ寄せる。
- 2026-04-04: `src-electron/project-scope.ts` と `scripts/tests/project-memory-storage.test.ts` を確認し、current は `gitRoot` をそのまま `projectKey` に使っていることを確認した。
- 2026-04-04: `projectKey` を `gitRemoteUrl -> repository identity -> gitRoot` の順で解決するように更新し、`git worktree` の legacy scope を現在開いている repository key へ寄せる migration を `ProjectMemoryStorage` に追加した。
- 2026-04-04: `docs/design/project-memory-storage.md` と `docs/design/memory-architecture.md` を、repository 単位共有前提の記述へ更新した。
- 2026-04-04: `node --import tsx scripts/tests/project-memory-storage.test.ts` と `npm run build` で確認した。
