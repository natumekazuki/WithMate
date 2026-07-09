# 目的

- WithMate 全体の最適化候補を、`1機能 = 1ブランチ` で実装に切り出せる粒度まで整理する
- frontend / backend をまたぐボトルネックを、主対象ファイルと着手順つきで棚卸しする
- current repo に、次の最適化 task の入口として使える roadmap 文書を残す

# スコープ

- `docs/optimization-roadmap.md` の新規作成
- 最適化候補 7-8 件の選定
- 候補ごとの推奨 branch 名、対象領域、主要ファイル、非効率ポイント、最適化方針、依存メモの整理
- repo plan 一式の作成と、今回の調査結果の記録
- 必要最小限の `README.md` 導線追加

# 非スコープ

- 実際の最適化実装
- profiler / benchmark 基盤の追加
- docs 以外のコード修正

# 調査観点

以下の論点を roadmap に必ず反映する。

- `src-electron/session-storage.ts` の `messages_json / stream_json`
- `src/session-state.ts` の `cloneSessions()`
- `src-electron/main-query-service.ts` の clone / query
- `src-electron/window-broadcast-service.ts` と `src-electron/main-broadcast-facade.ts`
- `src/HomeApp.tsx` と `src/App.tsx` の巨大 state / projection
- `src-electron/codex-adapter.ts` と `src-electron/snapshot-ignore.ts` の workspace snapshot / diff
- `src-electron/workspace-file-search.ts` の index TTL 5秒
- `src/memory-management-view.ts` の全件 filter / sort
- `src-electron/skill-discovery.ts` と `src-electron/custom-agent-discovery.ts` の同期 I/O
- `src-electron/project-memory-retrieval.ts` と `src-electron/character-memory-retrieval.ts` の全件 scoring

# 進め方

1. 関連コードと既存 docs のトーンを確認する
2. 最適化候補を `機能単位` に束ね、branch 切りできる粒度へ整理する
3. 優先度の考え方と推奨実装順を明文化する
4. repo plan と roadmap 文書を更新し、README 導線を必要最小限で追加する

# 完了条件

- `docs/plans/20260413-optimization-roadmap/` に `plan.md` `decisions.md` `worklog.md` `result.md` `questions.md` が存在する
- `questions.md` の status が `質問なし` になっている
- `docs/optimization-roadmap.md` に候補一覧、branch 命名ルール、優先度、推奨実装順が記載されている
- main agent が、そのまま follow-up branch を切れる情報が repo 内に残っている
