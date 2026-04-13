# Decisions

## Decision 1

- status: confirmed
- decision: Session Window の入力遅延は既存候補へ埋め込まず、`Session input responsiveness` として独立候補にする
- rationale:
  - `src/App.tsx` では `draft` 変更ごとに `previewComposerInput()` が 120ms debounce で走り、`@path` 検索も 100ms debounce で `searchWorkspaceFiles()` を呼ぶため、入力経路だけで独立した user pain が成立している
  - `src-electron/composer-attachments.ts` の `resolveComposerPreview()` が `stat()` を伴い、preview 解決と入力更新の競合を単独 task で切り出した方が検証しやすい
  - broad な renderer 改修へ吸収すると、体感改善の完了条件が曖昧になるため

## Decision 2

- status: confirmed
- decision: 初期表示時の全データ読込は `Session persistence summary/detail hydration` と `Session broadcast slimming` の 2 候補へ明示的に反映する
- rationale:
  - `src/App.tsx` と `src/HomeApp.tsx` の初期表示時フローで全件取得・購読があり、query 側と broadcast 側を分けて整理した方が branch 粒度を保ちやすい
  - `src-electron/session-storage.ts` が `listSessions()` / `getSession()` の両方で full row を扱い、`src-electron/main-query-service.ts` でも `getSession()` が clone 前提になっているため、summary/detail の取得境界を roadmap 上で明示する必要がある

## Decision 3

- status: confirmed
- decision: AuditLog の逐次追記は `Audit log live persistence` として独立候補にする
- rationale:
  - `src-electron/session-runtime-service.ts` は running row を create した後、完了時・失敗時にまとめ update しており、実行中の可視性不足が user feedback と一致している
  - `src/App.tsx` の audit log UI は再取得型と live run subscription が分かれており、永続化モデルを見直す task を独立させた方が UI 契約を整理しやすい
  - この候補は純粋な最適化だけでなく observability / durability 改善でもあり、優先度判断を分けて残す価値があるため

## Decision 4

- status: confirmed
- decision: `Renderer state decomposition` は standalone 候補から外し、局所 task へ吸収する
- rationale:
  - 候補名が広すぎると `1機能 = 1ブランチ` の完了条件が曖昧になる
  - 今回の user feedback は Session 入力、初期表示、AuditLog という具体的な pain に寄っており、局所 task の方が優先度を説明しやすい

## Decision 5

- status: confirmed
- decision: publish 前提の次アクションでは、detached HEAD を解消する docs 用 branch 作成を前提条件として明記する
- rationale:
  - 現在の worktree は `HEAD (no branch)` であり、このままでは docs 更新の commit / push / PR 作成先が定まらない
  - 今回は docs 更新のみのため、publish は `opt/...` ではなく docs 用 branch を先に切ってから進める方が安全である

## Decision 6

- status: confirmed
- decision: `Session input responsiveness` は UI 側の発火制御と preview/query 軽量化に限定し、`@path` 検索の cache / index 改善は `Workspace file search index` へ分離する
- rationale:
  - 両候補とも入力遅延へ効くが、片方は composer 入力の hot path、もう片方は workspace search 基盤の cache / index で責務が異なる
  - roadmap 上で両方に cache 改善を書いてしまうと `1機能 = 1ブランチ` の完了条件が曖昧になり、次の branch を切る判断材料として弱くなる
  - UI 側の debounce / scheduling / active session lookup は `Session input responsiveness` で閉じ、scan 頻度低減と invalidation は `Workspace file search index` に集約した方が段階導入しやすい
