# Plan

## 問題

- `#24` は model switch 後に `セッションが存在しない` で継続不能になる
- `#32` は long-idle 後に `Session not found` で再開不能になる
- current 実装では Codex / Copilot とも model / reasoningEffort 更新時に `threadId` を維持しており、design doc の「model / depth 変更時は reset」と不整合がある
- runtime 側にも `NotFound / expiry / invalid-thread / model-incompatible` を分類して回復する仕組みがない

## スコープ

- `#24` と `#32` を session resume / provider thread lifetime の同一クラスタとして整理する
- current code / design doc / backlog のズレを明文化する
- 最もありそうな原因仮説と、実装前に採るべき対応方針を決める
- 実装は行わず、follow-up task に切り分ける

## Out Of Scope

- provider adapter / runtime / UI の実装修正
- 実機での追加再現テスト
- backlog 全体の priority 再編

## 調査方針

1. `docs/task-backlog.md` の `#24` と `#32` の記述を確認し、症状差を固定する
2. `src/session-state.ts` と `src/App.tsx` を確認し、model switch 時の metadata update と `threadId` 維持挙動を確認する
3. `src-electron/codex-adapter.ts` / `src-electron/copilot-adapter.ts` を確認し、resume path が stale `threadId` をどう扱うかを見る
4. `src-electron/session-runtime-service.ts` を確認し、失効 / 非互換 / NotFound 専用 recovery の有無を確認する
5. `docs/design/provider-adapter.md` と current 実装の差分を整理し、対応方針を決める

## 完了条件

- `#24` と `#32` の関係を、同一クラスタとして扱う根拠付きで説明できる
- 原因仮説を 2〜3 個まで絞って優先度付きで整理できる
- 実装前に必要な follow-up 方針が `result.md` と `decisions.md` に残る
- `docs/task-backlog.md` の `#24` / `#32` メモが今回の調査結果に沿って更新される
- session workspace の `plan.md` に current task / scope / next steps が反映される

## リスク

- `#24` は provider が未特定のため、Codex 固有の model-switch 非互換がどこまで実測済みかは残る
- provider backend 側の session lifetime は外部仕様変更の影響を受けうる
- recovery 方針だけ先に決めても、telemetry が薄いままだと再発時の切り分けが遅い
