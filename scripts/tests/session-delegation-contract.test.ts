import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionRuntimeOperationInput } from "../../src/session-external-runtime-contract.js";
import { createSessionRuntimeInputSchema, parseSessionRuntimeResultEnvelope } from "../../src/session-external-runtime-schema.js";

const request = {
  idempotencyKey: "assignment-1", dispatch: "prepare",
  items: [{
    target: { kind: "existing", sessionId: "child-1" },
    work: { kind: "existing", workItemId: "work-1" },
    turn: { catalogRevision: 1, turn: {
      provider: "codex", userMessage: "Implement the requested change", model: "gpt-5.4", reasoningEffort: "high",
      approvalMode: "on-request", codexSandboxMode: "workspace-write", attachments: [],
    } },
  }],
};

// @test-value v2
// kind = "invariant"
// claim = "Delegation入力の既存resource指定とprepare/dispatchがTS parserと公開schemaで一致し、step identityの自己指定を拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md" }
// fault = "adapterごとに異なる入力を受理し、callerのstep keyやexecution対象がownerで解決したidentityを上書きする"
// observable = "両parserの正規化結果と不正入力の拒否"
// observation_boundary = "public-boundary"
// scope = "delegation public input"
// lifecycle = "permanent"
// @end-test-value
test("delegation input parsers agree on prepare, dispatch and runtime-owned identity", () => {
  const schema = createSessionRuntimeInputSchema("delegation.create");
  assert.deepEqual(parseSessionRuntimeOperationInput("delegation.create", request), schema.parse(request));
  const dispatch = { ...request, dispatch: "enqueue" };
  assert.deepEqual(parseSessionRuntimeOperationInput("delegation.create", dispatch), schema.parse(dispatch));
  for (const invalid of [
    { ...request, actorSessionId: "someone-else" },
    { ...request, items: [] },
    { ...request, items: Array.from({ length: 21 }, () => request.items[0]) },
    { ...request, items: [{ ...request.items[0], turn: { ...request.items[0].turn, sessionId: "other" } }] },
    { ...request, items: [{ ...request.items[0], turn: { ...request.items[0].turn, idempotencyKey: "other" } }] },
    { ...request, items: [{ ...request.items[0], work: { kind: "root" } }] },
  ]) {
    assert.throws(() => parseSessionRuntimeOperationInput("delegation.create", invalid));
    assert.equal(schema.safeParse(invalid).success, false);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Delegation応答は部分成功resource IDとownerのeffectを保持し、内部requestを公開しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/09-public-api-migration-and-review.md" }
// fault = "部分成功を捨てるか、保存した内部requestを公開responseへ混入する"
// observable = "canonical response validatorの受理結果と追加private fieldの拒否"
// observation_boundary = "public-boundary"
// scope = "delegation public output"
// lifecycle = "permanent"
// @end-test-value
test("delegation output retains partial resources and rejects private request data", () => {
  const result = {
    id: "delegation-1", revision: 3, state: "recovery_required",
    items: [{ index: 0, sessionId: "child-1", workItemId: "work-1", executionId: null,
      createdSession: true, createdWorkItem: true, state: "recovery_required", pendingStep: "turn",
      effect: "applied", error: { code: "PROVIDER_DISABLED", message: "Provider is disabled.", retryable: true, effect: "not_applied", details: {} } }],
    recoveryActions: ["retry", "cancel", "compensate"], createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:01.000Z",
  };
  const response = { schemaVersion: "withmate-session-result-v2", operation: "delegation.get", result };
  assert.deepEqual(parseSessionRuntimeResultEnvelope("delegation.get", response), response);
  assert.throws(() => parseSessionRuntimeResultEnvelope("delegation.get", { ...response, result: { ...result, request } }));
  const retry = { delegationId: result.id, expectedRevision: result.revision, idempotencyKey: "retry-1", dispatch: "enqueue" };
  assert.deepEqual(parseSessionRuntimeOperationInput("delegation.retry", retry), createSessionRuntimeInputSchema("delegation.retry").parse(retry));
});
