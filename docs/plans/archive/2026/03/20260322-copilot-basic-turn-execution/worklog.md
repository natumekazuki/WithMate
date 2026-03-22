# Worklog

## 2026-03-22

- follow-up task `基本 turn 実行` 用の plan を作成した
- `@github/copilot-sdk` を導入し、local README / type definitions を確認する準備を整えた
- current rollout plan から、この task の scope を `1 turn 実行` に限定した
- local SDK / generated type を確認し、`createSession` / `resumeSession` / `sendAndWait` / `assistant.message_delta` / `tool.execution_*` / `permission.*` が今回の実装面になると整理した
- `src-electron/provider-runtime.ts` と `src-electron/provider-prompt.ts` を追加して、Codex / Copilot 共通の provider contract を切り出した
- `src-electron/copilot-adapter.ts` を追加し、text-only の Copilot turn 実行、assistant text streaming、minimal command live step、minimal audit result を実装した
- `src-electron/main.ts` に provider dispatch を追加し、`public/model-catalog.json` に `copilot` provider を追加した
- `scripts/tests/model-catalog-settings.test.ts` と `scripts/tests/model-catalog-storage.test.ts` を更新して `copilot` catalog と `skillRootPath` の正規化を反映した
- `docs/design/provider-adapter.md`、`docs/design/coding-agent-capability-matrix.md`、`docs/design/codex-capability-matrix.md`、`docs/manual-test-checklist.md`、`README.md` を同期した
- 実装検証として `npm run typecheck`、`node --import tsx --test scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/model-catalog-storage.test.ts scripts/tests/approval-mode.test.ts`、`npm run build`、Copilot adapter smoke を実施した

## Validation

- `npm run typecheck`
- `node --import tsx --test scripts/tests/app-settings-storage.test.ts scripts/tests/model-catalog-settings.test.ts scripts/tests/model-catalog-storage.test.ts scripts/tests/approval-mode.test.ts`
- `npm run build`
- `CopilotAdapter` smoke
  - prompt: `2+2 を数字だけで答えて`
  - result: `assistantText = "4"`

## Commit

- `f6850da` `feat(copilot): add minimal provider integration`
  - `基本 turn 実行` slice 本体、shared runtime contract、Copilot model catalog 追加、関連 docs/test を記録した
