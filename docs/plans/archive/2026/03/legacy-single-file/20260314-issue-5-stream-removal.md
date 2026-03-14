# Issue 5 Stream Removal Plan

## Goal
- Issue #5 の方針に合わせて、独り言システムの UI を `Session Window` から一旦完全撤去する。
- `Character Stream` 前提で組んでいたレイアウトを、`Work Chat` と `Diff Viewer` 中心の構成へ戻す。
- 独り言機能は docs 上で pending とし、UI 上では存在を主張しない。

## Task List
- [x] `Session Window` から `Character Stream` UI を削除する。
- [x] `Session Window` のレイアウトと CSS を単一主面前提に整理する。
- [x] `ui-react-mock` / `product-direction` / `monologue-provider-policy` などの docs を UI 撤去方針に更新する。
- [x] plan を更新し、`typecheck` と `build` を通す。

## Affected Files
- `docs/plans/20260314-issue-5-stream-removal.md`
- `src/App.tsx`
- `src/styles.css`
- `docs/design/ui-react-mock.md`
- `docs/design/product-direction.md`
- `docs/design/monologue-provider-policy.md`
- 必要に応じて `docs/design/window-architecture.md`

## Risks
- 右カラムを外すことで `Session Window` の余白バランスが変わる。
- Character Stream を完全に消すと、WithMate 固有価値の見え方は一時的に弱まる。
- 後で再導入するときに、レイアウト差分が大きくなる可能性がある。

## Design Check
- 既存 design doc の更新が必須。

## Notes / Logs
- 2026-03-14: pending 表示も含めて独り言 UI は一旦完全撤去した。
- 2026-03-14: `Session Window` は `Work Chat` と `Diff Viewer` に集中する単一主面構成へ戻した。
- 2026-03-14: 独り言機能は UI から消したうえで、provider / memory の土台設計だけ docs に残す方針へ揃えた。
