# Codex Session Run Integration Plan

## Goal
- `Session Window` の `Send` を mock 更新ではなく Codex SDK 実行へ接続する。
- `character.md` (`roleMarkdown`) を prompt composition 経由で Codex 実行時に注入する。
- 実行結果を session state と UI に反映する最小ループを成立させる。

## Task List
- [x] `docs/design/provider-adapter.md` を作成し、Codex adapter 境界と prompt composer の接続点を定義する。
- [x] Main Process に最小の `CodexAdapter` 実装を追加する。
- [x] `prompt-composition.md` に合わせて `fixed system prompt + roleMarkdown + user input` の合成処理を実装する。
- [x] `Session Window` の `Send` を IPC 経由で Main Process 実行へ接続する。
- [x] 実行中 / 完了 / エラーの session state 更新を main store に反映する。
- [x] assistant message への応答反映と最小の artifact summary 生成を行う。
- [x] 関連 docs / plan を更新し、型チェックとビルドを通す。

## Affected Files
- `docs/plans/20260313-codex-session-run-integration.md`
- `docs/design/provider-adapter.md`
- `docs/design/prompt-composition.md`
- `docs/design/session-persistence.md`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src/withmate-window.ts`
- `src/App.tsx`
- 新規 adapter 実装ファイル（例: `src-electron/codex-adapter.ts`）
- `src/app-state.ts`
- `src/HomeApp.tsx`
- `docs/design/recent-sessions-ui.md`

## Risks
- Codex SDK の turn event をそのまま UI 表示に使うと粒度が荒い可能性がある。
- 実行中 state と session store 更新の競合を雑に扱うと renderer がちらつく。
- prompt composer の固定指示を入れすぎると character role と責務がぶつかる。

## Design Check
- このタスクは新しい実行境界を追加するため design doc 更新が必須。
- 新規または更新対象:
  - `docs/design/provider-adapter.md`
  - `docs/design/prompt-composition.md`
  - `docs/design/session-persistence.md`

## Notes / Logs
- 2026-03-13: `character.md` は prompt 合成の主要入力として整理済み。
- 2026-03-13: SDK は CLI を spawn しており、`CODEX_HOME/Agents.md` を見る挙動は CLI と SDK の両方で実測確認した。
- 2026-03-13: global `AGENTS.md` 依存は避け、WithMate 側で prompt composition を明示的に管理する方針とする。
- 2026-03-13: session metadata に `characterId` と `threadId` を持たせ、adapter が role 定義と Codex thread を復元できるようにした。

