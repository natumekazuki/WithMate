# Plan

- task: Project Memory の scope を worktree-aware にする
- date: 2026-04-04
- owner: Codex

## 目的

- `git worktree` 配下でも `Project Memory` を worktree 単位ではなく repository 単位で共有できるようにする
- UI 表示名と内部識別子の責務を分ける

## スコープ

- `src-electron/project-scope.ts`
- `src-electron/project-memory-storage.ts`
- 関連 test
- `docs/design/project-memory-storage.md`
- `docs/design/memory-architecture.md`

## 進め方

1. current の `project scope` 解決と test を確認する
2. `gitRemoteUrl` 優先、fallback で repository identity を使う key 解決を実装する
3. storage / test / design doc を同期する

## チェックポイント

- [ ] current の scope 解決と test を確認する
- [ ] worktree-aware な `projectKey` 解決を実装する
- [ ] test と docs を更新する
