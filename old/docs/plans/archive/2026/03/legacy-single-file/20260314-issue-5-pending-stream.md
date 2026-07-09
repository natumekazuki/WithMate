# Issue 5 Alignment Plan

## Goal
- Issue #5 の方針に合わせて、独り言システムの UI 適用を pending 扱いへ整理する。
- `Character Stream` を本実装済みに見える状態から、縮退表示または保留表示へ変更する。
- 独り言の土台実装と UI 適用の境界を docs に明文化する。

## Task List
- [x] Issue #5 の意図を current design に照らして整理する。
- [x] `Session Window` の `Character Stream` を pending 前提の縮退表示へ変更する。
- [x] stream に擬似発話を差し込む現行ロジックを停止または縮退表示専用に整理する。
- [x] `monologue-provider-policy` / `product-direction` / `ui-react-mock` など関連 docs を更新する。
- [x] plan を更新し、`typecheck` と `build` を通す。

## Affected Files
- `docs/plans/20260314-issue-5-pending-stream.md`
- `docs/design/monologue-provider-policy.md`
- `docs/design/product-direction.md`
- `docs/design/ui-react-mock.md`
- `src/App.tsx`
- `src-electron/main.ts`
- `src/app-state.ts`
- 必要に応じて `docs/design/character-chat-ui.md`

## Risks
- Character Stream を急に弱めると、プロダクトの見た目の価値が一時的に下がる。
- 右カラムを単純に空にすると session UI 全体の密度バランスが崩れる。
- pending 表示を入れすぎると単なる未実装感だけが強くなる。

## Design Check
- 既存の `docs/design/monologue-provider-policy.md` と `docs/design/product-direction.md` の更新が必須。

## Notes / Logs
- 2026-03-14: 現行の `Character Stream` は OpenAI API 連携ではなく、session state へ擬似文言を差し込むだけの実装だった。
- 2026-03-14: Issue #5 に合わせ、Session UI では pending state を表示し、擬似発話の差し込みは停止した。
- 2026-03-14: 独り言の本実装は `monologue-provider-policy` と `memory-architecture` の土台整備後に再開する前提へ揃えた。

