# Worklog

## 2026-03-31

### 調査対象

- `docs/task-backlog.md`
- `src/session-state.ts`
- `src/App.tsx`
- `src-electron/codex-adapter.ts`
- `src-electron/copilot-adapter.ts`
- `src-electron/session-runtime-service.ts`
- `docs/design/provider-adapter.md`

### 確認した事実

- backlog 上では `#24` は model switch 時の `セッションが存在しない`、`#32` は約 1 時間 idle 後の `Session not found`
- `src/session-state.ts` の `applySessionModelMetadataUpdate()` は `copilot` / `codex` で model metadata 更新時も `threadId` を維持する
- `src/App.tsx` の model switch UI は `applySessionModelMetadataUpdate()` を通して session metadata を保存する
- `src-electron/codex-adapter.ts` は `threadId` があれば `client.resumeThread(threadId, options)` を試す
- `src-electron/copilot-adapter.ts` は `threadId` があれば `client.resumeSession(threadId, config)` を試す
- `src-electron/session-runtime-service.ts` は canceled 時の invalidation はあるが、`NotFound / expiry / invalid-thread / model-incompatible` 専用 recovery は持たない
- `docs/design/provider-adapter.md` は model / reasoning depth 変更時の `threadId` reset を正本にしており、current 実装とズレている

### まとめ

- `#24` と `#32` はどちらも stale `threadId` reuse の露出として説明できる
- `#24` だけは model switch を契機にするため、Codex の model-switch resume 非互換が加算要因になりうる
- root cause を 1 個に決め打ちするより、expiry / model incompatibility / recovery 不足の 3 層で扱う方が実装順と観測面に合う

### クローズ記録

- final doc validation / review passed を確認した
- `2dc744c docs(task-backlog): #24 と #32 の調査結果を整理` を作成し、調査結果 docs・backlog メモ更新・active plan artifacts を記録した
