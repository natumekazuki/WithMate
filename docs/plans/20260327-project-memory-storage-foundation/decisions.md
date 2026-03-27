# Decisions

## 2026-03-27

- current slice では `Project Memory` の persistence foundation だけ実装する
- `projectKey` は `projectType` を含む canonical string にする
- `gitRemoteUrl` は current slice では `null` 許容のままにし、必須取得しない
