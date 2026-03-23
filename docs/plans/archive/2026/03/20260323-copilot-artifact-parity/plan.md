# Plan

## Goal

- `GitHub Copilot` provider でも assistant message に最小 `artifact` を付与し、chat bubble の `Details` を開ける状態にする
- 少なくとも `operationTimeline`、`runChecks`、snapshot diff fallback の `changedFiles` を組み立てる
- `Latest Command` と Audit Log に出ている情報を、chat bubble 側の `Details` にも接続する

## Scope

- `src-electron/copilot-adapter.ts` の artifact 生成
- 必要なら snapshot / diff helper の切り出し
- `scripts/tests/copilot-adapter.test.ts` または関連テスト追加
- `docs/design/provider-adapter.md`、`docs/design/coding-agent-capability-matrix.md`、`docs/manual-test-checklist.md` の同期
- plan 記録更新

## Out Of Scope

- Copilot の image attachment
- slash command
- provider-native custom agent selection

## Task List

- [x] Plan を作成する
- [x] Codex artifact builder のうち Copilot で流用する要素を整理する
- [x] Copilot turn で before / after snapshot を取り、`changedFiles` と `runChecks` を組み立てる
- [x] `artifact` を assistant message に付与し、`Details` が出ることを確認する
- [x] 回帰テストと docs / plan 記録を更新する

## Affected Files

- `src-electron/copilot-adapter.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/snapshot-ignore.ts`
- `scripts/tests/copilot-adapter.test.ts`
- `docs/design/provider-adapter.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/manual-test-checklist.md`
- `docs/plans/20260323-copilot-artifact-parity/`

## Risks

- snapshot diff helper の共有化で Codex 側既存挙動を崩す可能性がある
- Copilot provider-native tool だけでは変更種別が不完全なため、snapshot diff fallback の品質に依存する
- giant workspace では snapshot warning の扱いを誤ると `変更なし` と誤認させる
