import assert from "node:assert/strict";
import test from "node:test";
import { runMainRuntimeOptionOperation, type MainRuntimeOption } from "../../src/chat/runtime/main-session-mutation-operations.js";
import { buildNewSession, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { ConfirmedReviewerChange } from "../../src-shared/session/session-mutation-contract.js";

// @test-value v2
// kind = "contract"
// claim = "実行中Mainの設定変更は次送信用に渡り、Claudeの確認済みApproval／Reviewer変更は一括送信し、read-onlyとnever時の通常Reviewer変更を拒否する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send" }
// fault = "runningを理由に次設定を拒否するか元Sessionを編集するかread-only/Reviewer禁止を迂回する"
// observable = "persist結果の設定fieldと確認情報、元capture、禁止操作の戻り値とpersist件数"
// observation_boundary = "public-boundary"
// scope = "main runtime option running selection"
// lifecycle = "permanent"
// impact = "次依頼を準備できず、または現在Turnの条件が予期せず変わる"
// distinction = "service testではRenderer helperのrunning拒否とprovider別分岐を通らない"
// @end-test-value
test("実行中Mainは次送信用の対応設定を編集できる", async () => {
  const session: Session = { ...buildNewSession({ id: "running-options", taskTitle: "Options", approvalMode: "on-request",
    workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "character",
    character: "Character", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" } }),
    status: "running", runState: "running", model: "model-a", reasoningEffort: "medium" };
  const captured = captureSessionExecutionOptions(session);
  let writes = 0;
  const cases: Array<{ option: MainRuntimeOption; field: keyof typeof captured; expected: string }> = [
    { option: { kind: "approval-mode", value: "never" }, field: "approvalMode", expected: "never" },
    { option: { kind: "codex-sandbox-mode", value: "danger-full-access" }, field: "codexSandboxMode", expected: "danger-full-access" },
    { option: { kind: "codex-speed", value: "fast" }, field: "codexSpeed", expected: "fast" },
    { option: { kind: "codex-reviewer", value: "auto-review" }, field: "codexReviewer", expected: "auto-review" },
    { option: { kind: "model", value: { id: "model-b", label: "B", reasoningEfforts: ["medium", "high"] } }, field: "model", expected: "model-b" },
    { option: { kind: "reasoning-effort", value: "high" }, field: "reasoningEffort", expected: "high" },
  ];
  const input: Omit<Parameters<typeof runMainRuntimeOptionOperation>[0], "option"> = { session, isReadOnly: false,
    providerCatalog: { id: "codex", label: "Codex", defaultModelId: "model-a", defaultReasoningEffort: "medium",
      models: [{ id: "model-a", label: "A", reasoningEfforts: ["medium", "high"] }, { id: "model-b", label: "B", reasoningEfforts: ["medium", "high"] }] },
    persist: async (next) => { writes += 1; return next; }, createTimestampLabel: () => "now" };
  for (const { option, field, expected } of cases) {
    assert.equal((await runMainRuntimeOptionOperation({ ...input, option }))?.[field], expected);
  }
  assert.equal((await runMainRuntimeOptionOperation({ ...input, session: { ...session, provider: "copilot" }, option: { kind: "custom-agent", value: "reviewer" } }))?.customAgentName, "reviewer");
  assert.equal(await runMainRuntimeOptionOperation({ ...input, isReadOnly: true, option: cases[0]!.option }), null);
  assert.equal(await runMainRuntimeOptionOperation({ ...input, session: { ...session, approvalMode: "never" }, option: { kind: "codex-reviewer", value: "auto-review" } }), null);
  assert.deepEqual(captureSessionExecutionOptions(session), captured);
  assert.equal((await runMainRuntimeOptionOperation({ ...input, session: { ...session, provider: "claude", approvalMode: "on-request" }, option: { kind: "codex-reviewer", value: "auto-review" } }))?.codexReviewer, "auto-review");
  assert.equal(writes, 8);
  const combined: unknown[] = [];
  const confirmed = { previousApprovalMode: "never" as const };
  const claude = { ...session, provider: "claude", approvalMode: "never" as const, codexReviewer: "auto-review" as const };
  const update = { ...input, session: claude, persist: async (next: Session, confirmation?: ConfirmedReviewerChange) => {
    combined.push([next.approvalMode, next.codexReviewer, confirmation]); return next;
  } };
  await runMainRuntimeOptionOperation({ ...update, option: { kind: "approval-mode", value: "plan", confirmedReviewerChange: confirmed } });
  assert.deepEqual(combined, [["plan", "user", confirmed]]);
  assert.equal(await runMainRuntimeOptionOperation({ ...update, session: { ...claude, approvalMode: "on-request" }, option: { kind: "approval-mode", value: "plan", confirmedReviewerChange: confirmed } }), null);
  assert.equal(combined.length, 1);
});
