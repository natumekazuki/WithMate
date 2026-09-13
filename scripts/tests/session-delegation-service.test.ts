import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildNewSession } from "../../src/session-state.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import { parseSessionRuntimeOperationInput, createSessionRuntimeError, type SessionRuntimeOperation, type SessionRuntimeResultEnvelope } from "../../src/session-external-runtime-contract.js";
import type { DelegationCreateInput } from "../../src/delegation.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { DelegationStorage } from "../../src-electron/delegation-storage.js";
import { DelegationOperationError, DelegationService } from "../../src-electron/delegation-service.js";

const now = "2026-09-13T00:00:00.000Z";
const binding: ResolvedAgentRuntimeBinding = { bindingId: "test", bindingIdHash: "test", actorSessionId: "root", providerId: "codex", executionGeneration: "generation", authoritySnapshot: {}, operationGrants: ["session.runtime.invoke"], createdAt: now, expiresAt: null };
const proof: MutationAuthorityProof = { principal: { kind: "user", receiptId: "test" }, operation: "delegation.create", action: "delegation.create", mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, effectClass: "external_side_effect", grantId: null, grantRevision: null, evaluatedAt: now,
  resolvedScope: { resourceKind: "session", resourceId: "root", rootSessionId: "root", ownerKind: "session", ownerId: "root", relation: "self" } };
const request: DelegationCreateInput = {
  idempotencyKey: "create-1", dispatch: "enqueue", items: [{
    target: { kind: "create", session: { expectedContainerRevision: 1, placement: { kind: "child", parentSessionId: "root", sessionRole: "executor" }, title: "child", character: { characterId: "character", expectedDefinitionSha256: "definition" }, provider: { id: "codex", catalogRevision: 1, model: "model", reasoningEffort: "high", threadContinuity: "reset", approvalMode: "on-request", codexSandboxMode: "workspace-write", allowedAdditionalDirectories: [] }, workspace: { kind: "directory", path: "workspace" }, initialGrant: { kind: "inherit" }, budget: { kind: "inherit" } } },
    work: { kind: "create", contract: { goal: "goal", scope: "scope", completionCriteria: "done", authority: "local", sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null } } },
    turn: { catalogRevision: 1, turn: { provider: "codex", userMessage: "work", model: "model", reasoningEffort: "high", approvalMode: "on-request", codexSandboxMode: "workspace-write", attachments: [] } },
  }],
};

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "delegation-service-"));
  const dbPath = path.join(dir, "app.db");
  const sessions = new SessionStorageV6(dbPath);
  sessions.insertSession({ ...buildNewSession({ id: "root", taskTitle: "root", workspaceLabel: "workspace", workspacePath: dir, branch: "main", characterId: "character", character: "Character", characterIconPath: "", characterThemeColors: { main: "#ffffff", sub: "#000000" }, approvalMode: "never", rootSessionRole: "overall-coordinator" }), updatedAt: now });
  sessions.close();
  let storage = new DelegationStorage(dbPath);
  let failOperation: string | null = null;
  let failOnCall = 0;
  let failAfterCommit = false;
  let executionState = "queued";
  let executionAdmittedAt: string | null = null;
  let workState = "pending";
  let archived = false;
  let controlRevoked = false;
  let revokeAfter: string | null = null;
  let otherExecutions: unknown[] = [];
  const resources = new Map<string, Record<string, unknown>>();
  const attempts: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const execute = async (operation: SessionRuntimeOperation, raw: unknown) => {
    const input = parseSessionRuntimeOperationInput(operation, raw) as Record<string, unknown>;
    attempts.push({ operation, input: structuredClone(input) });
    if (operation === failOperation && !failAfterCommit && (failOnCall === 0 || attempts.filter((call) => call.operation === operation).length === failOnCall)) return createSessionRuntimeError({ code: "PROVIDER_DISABLED", message: "Disabled", effect: "not_applied", retryable: true });
    let result: unknown;
    if (operation === "session.get") result = { sessionId: input.sessionId, revision: 11 };
    else if (operation === "turn.get") result = { id: input.executionId, sessionId: input.sessionId, revision: 2, state: executionState, admittedAt: executionAdmittedAt };
    else if (operation === "turn.list") result = { items: otherExecutions };
    else if (operation === "work.get") result = { id: input.workItemId, targetSessionId: "child", state: workState, revision: 1, archivedAt: archived ? now : null };
    else if (operation === "session.delete.manifest") result = { blockers: [], descendants: [], artifacts: [], budgetReservations: [] };
    else {
      const key = `${operation}:${input.idempotencyKey}`;
      result = resources.get(key);
      if (!result) {
        result = operation === "session.create" ? { sessionId: "child", revision: 1 }
          : operation === "work.create" ? { id: "work", targetSessionId: "child" }
          : operation === "work.aggregation.retry" ? { decision: { parentWorkItemId: input.parentWorkItemId, childWorkItemId: input.childWorkItemId, decision: "retry_requested" }, replacement: { id: "replacement-work", targetSessionId: "child", revision: 1 } }
          : { id: "execution", sessionId: "child", revision: 1, state: executionState };
        resources.set(key, result as Record<string, unknown>);
      }
      if (operation === "turn.cancel") executionState = "canceled";
      if (operation === "work.cancel") workState = "canceled";
      if (operation === "work.archive") archived = true;
      if (operation === failOperation && failAfterCommit) throw new Error("Simulated response loss with private detail");
    }
    if (operation === revokeAfter) controlRevoked = true;
    return { schemaVersion: "withmate-session-result-v2", operation, result } as SessionRuntimeResultEnvelope;
  };
  const make = (timestamp = now) => new DelegationService({ storage, execute, authorizeControl: () => { if (controlRevoked) throw new DelegationOperationError({ code: "AUTHORITY_DENIED", message: "Revoked", retryable: false, effect: "not_applied", details: {} }); }, currentTimestamp: () => timestamp });
  return { dir, dbPath, get storage() { return storage; }, make, resources, attempts,
    fail(operation: string | null, afterCommit = false) { failOperation = operation; failAfterCommit = afterCommit; failOnCall = 0; },
    failAt(operation: string | null, call: number) { failOperation = operation; failAfterCommit = false; failOnCall = call; },
    revokeControlAfter(operation: string) { revokeAfter = operation; },
    setOtherExecutions(value: unknown[]) { otherExecutions = value; },
    setExecutionState(value: string) { executionState = value; },
    setExecutionAdmittedAt(value: string | null) { executionAdmittedAt = value; },
    reopen() { storage.close(); storage = new DelegationStorage(dbPath); return make(); },
    async close() { storage.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

// @test-value v2
// kind = "invariant"
// claim = "各作成ownerの応答消失後も保存された同じstep入力で再送し、Delegationのresource IDsと予算消費を重複させない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md" }
// fault = "step入力保存前に副作用を呼ぶ、再起動後にrevisionやkeyを再生成する、commit後の応答消失を正常応答として扱う"
// observable = "実SQLite再open後の委譲ID、step input、mock ownerの保存resource数、Delegation budget count"
// observation_boundary = "component-behavior"
// scope = "DelegationServiceと実SQLite保存。resource ownerはstrict input parser付き再送stubでありProviderの実起動は対象外"
// lifecycle = "permanent"
// @end-test-value
test("delegation resumes each lost owner response with its saved input after restart", async () => {
  for (const operation of ["session.create", "work.create", "turn.enqueue"]) {
    const f = await fixture();
    try {
      f.fail(operation, true);
      const first = await f.make().create(binding, request, proof);
      assert.equal(first.state, "recovery_required");
      assert.equal(first.items[0].effect, "indeterminate");
      assert.doesNotMatch(JSON.stringify(first), /private detail/);
      const pending = f.storage.getInternal(first.id, "root").pending;
      assert.equal(pending?.operation, operation);
      f.fail(null);
      const service = f.reopen();
      const retryInput = { delegationId: first.id, expectedRevision: first.revision, idempotencyKey: "retry-1", dispatch: "enqueue" as const };
      const resumed = await service.retry(binding, retryInput, proof);
      assert.equal(resumed.id, first.id);
      assert.equal(resumed.state, "active");
      assert.deepEqual([resumed.items[0].sessionId, resumed.items[0].workItemId, resumed.items[0].executionId], ["child", "work", "execution"]);
      assert.equal(f.resources.size, 3);
      const calls = f.attempts.filter((call) => call.operation === operation);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].input, calls[1].input);
      assert.deepEqual(await service.retry(binding, retryInput, proof), resumed);
      const db = new DatabaseSync(f.dbPath);
      try { assert.equal((db.prepare("SELECT committed FROM resource_budget_dimensions_v6 WHERE account_id='root' AND dimension='delegations'").get() as { committed: number }).committed, 1); } finally { db.close(); }
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "prepareではTurnを投入せず、stale revisionと別payload再送を副作用前に拒否し、明示retryだけがdispatchする"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md" }
// fault = "prepareが実行開始する、stale retryがTurnを投入する、同key別要求を受理する"
// observable = "公開state、owner呼出数、reject結果"
// observation_boundary = "component-behavior"
// scope = "DelegationService prepared admission"
// lifecycle = "permanent"
// @end-test-value
test("prepared work starts only with an admitted retry and cancels through the owner", async () => {
  const f = await fixture();
  try {
    const service = f.make();
    const input = { ...request, dispatch: "prepare" as const };
    const prepared = await service.create(binding, input, proof);
    assert.equal(prepared.state, "prepared");
    assert.equal(f.attempts.some((call) => call.operation === "turn.enqueue"), false);
    assert.deepEqual(await service.create(binding, input, proof), prepared);
    await assert.rejects(service.create(binding, { ...input, dispatch: "enqueue" }, proof), /another delegation request/);
    const before = f.attempts.length;
    await assert.rejects(service.retry(binding, { delegationId: prepared.id, expectedRevision: 1, idempotencyKey: "stale", dispatch: "enqueue" }, proof), /stale/);
    assert.equal(f.attempts.length, before);
    const active = await service.retry(binding, { delegationId: prepared.id, expectedRevision: prepared.revision, idempotencyKey: "start", dispatch: "enqueue" }, proof);
    const cancelled = await service.cancel(binding, { delegationId: active.id, expectedRevision: active.revision, idempotencyKey: "cancel" }, proof);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(f.attempts.filter((call) => call.operation === "turn.cancel").length, 1);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "Delegation batchは最初の失敗で停止し、先行itemのresource IDを保持したまま後続stepだけをretryして重複作成しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#部分成功とstep状態" }
// fault = "後続itemの失敗で先行結果を捨てる、batch全体を再実行してSession・Work Item・Turnを重複作成する"
// observable = "item別resource ID、owner呼出回数、retry後のexecution ID集合、後続itemのpending step"
// observation_boundary = "component-behavior"
// scope = "Delegation batch partial success and retry"
// lifecycle = "permanent"
// @end-test-value
test("batch keeps earlier resources and retries only the failed item", async () => {
  const f = await fixture();
  try {
    const batch = { ...request, idempotencyKey: "batch-1", items: [request.items[0], request.items[0]] };
    f.failAt("work.create", 2);
    const failed = await f.make().create(binding, batch, proof);
    assert.equal(failed.state, "recovery_required");
    assert.equal(failed.items[0].state, "active");
    assert.equal(failed.items[0].sessionId, "child");
    assert.equal(failed.items[0].workItemId, "work");
    assert.equal(failed.items[0].executionId, "execution");
    assert.equal(failed.items[1].state, "recovery_required");
    assert.equal(failed.items[1].workItemId, null);
    assert.equal(failed.items[1].pendingStep, "work.create");
    assert.equal(f.storage.getInternal(failed.id, "root").pending?.itemIndex, 1);
    const before = failed.items[0];
    f.fail(null);
    const retried = await f.make().retry(binding, { delegationId: failed.id, expectedRevision: failed.revision, idempotencyKey: "batch-retry", dispatch: "enqueue" }, proof);
    assert.equal(retried.items[0].sessionId, before.sessionId);
    assert.equal(retried.items[0].workItemId, before.workItemId);
    assert.equal(retried.items[0].executionId, before.executionId);
    assert.ok(retried.items[1].workItemId);
    assert.ok(retried.items[1].executionId);
    assert.equal(f.attempts.filter((call) => call.operation === "session.create").length, 2);
    assert.equal(f.attempts.filter((call) => call.operation === "work.create").length, 3);
    assert.equal(f.attempts.filter((call) => call.operation === "turn.enqueue").length, 2);
    assert.equal(retried.items.filter((item) => item.executionId !== null).length, 2);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "aggregation retryで作成されたreplacement Work ItemのIDを保存し、応答消失後も同じcanonical入力を再送してそのreplacementへTurnをenqueueする"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#作成" }
// fault = "replacement作成の応答消失で別replacementを作る、または元Work ItemへTurnを送る"
// observable = "work.aggregation.retryの入力、保存されたreplacement ID、turn.enqueueのworkItemId、owner呼出回数"
// observation_boundary = "component-behavior"
// scope = "Delegation aggregation replacement retry"
// lifecycle = "permanent"
// @end-test-value
test("replacement retry reuses the canonical input and dispatches the returned replacement", async () => {
  const f = await fixture();
  try {
    const replacementRequest = {
      ...request,
      idempotencyKey: "replacement-1",
      items: [{
        ...request.items[0],
        target: { kind: "existing" as const, sessionId: "child" },
        work: { kind: "replacement" as const, request: {
          parentWorkItemId: "parent-work", childWorkItemId: "child-work", goal: "retry goal", scope: "retry scope",
          completionCriteria: "retry done", authority: "retry authority", sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null },
          expectedAggregateRevision: 2,
        } },
      }],
    } as DelegationCreateInput;
    f.fail("work.aggregation.retry", true);
    const failed = await f.make().create(binding, replacementRequest, proof);
    assert.equal(failed.state, "recovery_required");
    assert.equal(f.storage.getInternal(failed.id, "root").pending?.operation, "work.aggregation.retry");
    const retryCall = f.attempts.find((call) => call.operation === "work.aggregation.retry");
    assert.ok(retryCall);
    f.fail(null);
    const resumed = await f.make().retry(binding, { delegationId: failed.id, expectedRevision: failed.revision, idempotencyKey: "replacement-retry", dispatch: "enqueue" }, proof);
    assert.equal(resumed.items[0].workItemId, "replacement-work");
    assert.equal(resumed.items[0].executionId, "execution");
    const replacementCalls = f.attempts.filter((call) => call.operation === "work.aggregation.retry");
    assert.equal(replacementCalls.length, 2);
    assert.deepEqual(replacementCalls[0].input, replacementCalls[1].input);
    const turnCall = f.attempts.find((call) => call.operation === "turn.enqueue");
    assert.equal(turnCall?.input.workItemId, "replacement-work");
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "admitted済みexecutionを補償するとき、Turn cancel後も開始済みresourceをWork/Session archiveで隠さずrecovery_requiredへ保持する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#公開操作" }
// fault = "providerへadmit済みのexecutionを未使用と扱い、Work ItemまたはSessionをarchiveして進行中の作業を隠す"
// observable = "recovery_required state、turn.cancel呼出、work.archive/session.archive未実行、遅延完了後の再補償でもresource ID保持"
// observation_boundary = "component-behavior"
// scope = "Delegation compensation after provider admission; provider completion itself is represented by the strict turn.get stub"
// lifecycle = "permanent"
// @end-test-value
test("compensation preserves work after an admitted execution", async () => {
  const f = await fixture();
  try {
    const active = await f.make().create(binding, request, proof);
    f.setExecutionAdmittedAt(now);
    const result = await f.make().compensate(binding, { delegationId: active.id, expectedRevision: active.revision, idempotencyKey: "admitted-compensate" }, proof);
    assert.equal(result.state, "recovery_required");
    assert.equal(result.items[0].error?.code, "DELEGATION_RESOURCE_IN_USE");
    assert.equal(f.attempts.filter((call) => call.operation === "turn.cancel").length, 1);
    assert.equal(f.attempts.filter((call) => call.operation === "work.archive").length, 0);
    assert.equal(f.attempts.filter((call) => call.operation === "session.archive").length, 0);
    assert.equal(f.storage.getInternal(result.id, "root").pending, null);
    f.setExecutionState("completed");
    const late = await f.reopen().compensate(binding, { delegationId: result.id, expectedRevision: result.revision, idempotencyKey: "late-compensate" }, proof);
    assert.equal(late.state, "recovery_required");
    assert.deepEqual([late.items[0].sessionId, late.items[0].workItemId, late.items[0].executionId], ["child", "work", "execution"]);
    assert.equal(f.attempts.filter((call) => ["work.cancel", "work.archive", "session.archive"].includes(call.operation)).length, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "補償途中の応答消失後に再openして取消済みWork Itemから補償を続行し、他の委譲が採用した資源は変更しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md" }
// fault = "補償済みstepの再実行や未実行cleanupを成功と扱う、採用済みresourceをcancel/archiveする"
// observable = "補償state、Work/Session owner呼出、再open後のpending、adoption後の無変更"
// observation_boundary = "component-behavior"
// scope = "実DelegationStorageとstub ownerによる補償進捗・採用競合"
// lifecycle = "permanent"
// @end-test-value
test("compensation resumes after a lost cancel response and preserves adopted resources", async () => {
  const f = await fixture();
  try {
    let service = f.make();
    const prepared = await service.create(binding, { ...request, dispatch: "prepare" }, proof);
    f.fail("work.cancel", true);
    const failed = await service.compensate(binding, { delegationId: prepared.id, expectedRevision: prepared.revision, idempotencyKey: "compensate-1" }, proof);
    assert.equal(failed.state, "recovery_required");
    assert.equal(f.storage.getInternal(failed.id, "root").pending?.operation, "work.cancel");
    f.fail(null);
    service = f.reopen();
    const complete = await service.compensate(binding, { delegationId: failed.id, expectedRevision: failed.revision, idempotencyKey: "compensate-2" }, proof);
    assert.equal(complete.state, "compensated");
    assert.equal(f.attempts.filter((call) => call.operation === "work.cancel").length, 1);
    assert.equal(f.attempts.filter((call) => call.operation === "work.archive").length, 1);
    assert.equal(f.attempts.filter((call) => call.operation === "session.archive").length, 1);
    assert.equal(f.storage.getInternal(failed.id, "root").pending, null);
  } finally { await f.close(); }
  const adoptedFixture = await fixture();
  try {
    const service = adoptedFixture.make();
    const prepared = await service.create(binding, { ...request, dispatch: "prepare" }, proof);
    await service.create(binding, { ...request, idempotencyKey: "reuse", dispatch: "prepare", items: [{ ...request.items[0], target: { kind: "existing", sessionId: "child" }, work: { kind: "existing", workItemId: "work" } }] }, proof);
    const before = adoptedFixture.attempts.length;
    const result = await service.compensate(binding, { delegationId: prepared.id, expectedRevision: prepared.revision, idempotencyKey: "compensate" }, proof);
    assert.equal(result.state, "recovery_required");
    assert.equal(result.items[0].error?.code, "DELEGATION_RESOURCE_ADOPTED");
    assert.equal(adoptedFixture.attempts.length, before);
  } finally { await adoptedFixture.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "新Root委譲だけが保存済み作成先の内部self認可で初回Turnへ進み、既存の別Rootを指定した入力はこの経路を使えない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md" }
// fault = "作成済みRootへの内部dispatchが存在しない、元bindingを書き換える、既存別Rootにも内部権限を適用する"
// observable = "公開delegation.createのresource IDs、owner、認可actor、execution admission actorと通常cross-root入力の拒否"
// observation_boundary = "public-boundary"
// scope = "実application/delegation/storage、認可とSession/Work/Execution ownerは明示stub。grant latticeそのものは対象外"
// lifecycle = "permanent"
// @end-test-value
test("created root dispatch uses its self authority without changing the caller binding", async () => {
  const { SessionExternalApplicationService } = await import("../../src-electron/session-external-application-service.js");
  const { SessionAuthorityError } = await import("../../src/session-authority.js");
  const f = await fixture();
  const seenActors: string[] = [];
  const original = structuredClone(binding);
  const root = { sessionId: "new-root", revision: 1, rootSessionId: "new-root", parentSessionId: null, sessionRole: "standalone", roleContractRevision: 1, delegationDepth: 0, workspace: { path: f.dir } };
  try {
    const app = new SessionExternalApplicationService({
      delegationStorage: f.storage,
      authorityService: {
        authorize(actor, operation, input) {
          if (operation === "session.get" && (input as { sessionId: string }).sessionId === "new-root") throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "No cross-root grant.");
          return { input, proof: { ...proof, operation, action: operation } as never };
        },
        authorizeSessionAct(actorSessionId, operation, input) {
          seenActors.push(actorSessionId);
          return { input, proof: { ...proof, principal: { kind: "agent", agent: "session-runtime", actorSessionId, runtimeGeneration: "internal" }, operation, action: operation } as never };
        },
        canSessionAct() { return true; },
      },
      crudService: { async create() { return root as never; }, async get() { return root as never; } } as never,
      workItemService: {
        getRootWorkItem(sessionId: string, actor: { actorSessionId: string }) {
          assert.equal(sessionId, "new-root"); assert.equal(actor.actorSessionId, "new-root");
          return { id: "root-work", kind: "root", predecessorWorkItemId: null };
        },
        requireExecutionAssociation(workId: string, actor: string, target: string) {
          assert.deepEqual([workId, actor, target], ["root-work", "new-root", "new-root"]);
        },
      } as never,
      executionService: {
        resolveReplay() { return null; },
        async enqueue(input: { proof: { principal: { actorSessionId: string } }; sessionId: string; request: { initiator: { sessionId: string } } }) {
          assert.equal(input.proof.principal.actorSessionId, "new-root");
          assert.equal(input.request.initiator.sessionId, "new-root");
          return { id: "root-execution", sessionId: input.sessionId, operation: "turn.enqueue", state: "queued", revision: 1, result: null, errorCode: "", reason: "", createdAt: now, admittedAt: null, completedAt: null, updatedAt: now };
        },
      } as never,
      currentModelCatalog: () => ({ revision: 1, providers: [] }) as never,
      getTurnAuthoritySession: () => root as never,
      resolveTurnInitiator: async (actor) => ({ kind: "session", sessionId: actor, character: { characterId: "character", name: "Character", iconFilePath: "" } }),
      isProviderEnabled: () => true, isProviderSupported: () => true, discoverSessionCustomAgents: async () => [],
    });
    const baseTarget = request.items[0].target;
    assert.equal(baseTarget.kind, "create");
    if (baseTarget.kind !== "create") throw new Error("fixture");
    const input = { ...request, items: [{ ...request.items[0], target: { kind: "create", session: { ...baseTarget.session, placement: { kind: "root", rootKind: "standalone" } } }, work: { kind: "root" } }] };
    const result = await app.execute("delegation.create", input, binding);
    assert.ok("result" in result);
    const delegation = (result as { result: import("../../src/delegation.js").Delegation }).result;
    assert.equal(delegation.state, "active", JSON.stringify(delegation));
    assert.deepEqual([delegation.items[0].sessionId, delegation.items[0].workItemId, delegation.items[0].executionId], ["new-root", "root-work", "root-execution"]);
    assert.ok(seenActors.length > 0);
    assert.ok(seenActors.every((actor) => actor === "new-root"));
    assert.equal(f.storage.get(delegation.id, "root").id, delegation.id);
    assert.deepEqual(binding, original);
    const denied = await app.execute("delegation.create", { ...request, idempotencyKey: "existing-root", items: [{ ...request.items[0], target: { kind: "existing", sessionId: "new-root" }, work: { kind: "existing", workItemId: "root-work" } }] }, binding);
    assert.ok("result" in denied);
    assert.equal((denied as { result: import("../../src/delegation.js").Delegation }).result.items[0].error?.code, "AUTHORITY_FORBIDDEN");
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "応答消失した作成stepのretention超過ではownerを再実行せず、以前のeffect不明と作成済みIDを保持する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#部分成功とstep状態" }
// fault = "retention拒否を以前の副作用がnot_appliedだった証拠と扱い、不明な作成stepのcleanupを可能にする"
// observable = "owner呼出回数不変、effect indeterminate、Session/Work IDs保持、空のrecoveryActions"
// observation_boundary = "component-behavior"
// scope = "実SQLiteのpending保存とDelegationServiceの時刻境界。owner応答消失はstubで再現"
// lifecycle = "permanent"
// @end-test-value
test("expired uncertain dispatch preserves effect uncertainty without replay", async () => {
  const f = await fixture();
  try {
    f.fail("turn.enqueue", true);
    const first = await f.make().create(binding, request, proof);
    const calls = f.attempts.length;
    f.fail(null);
    const result = await f.make("2026-09-14T00:00:00.000Z").retry(binding, { delegationId: first.id, expectedRevision: first.revision, idempotencyKey: "expired-retry", dispatch: "enqueue" }, proof);
    assert.equal(f.attempts.length, calls);
    assert.equal(result.items[0].error?.effect, "indeterminate");
    assert.equal(result.items[0].effect, "indeterminate");
    assert.deepEqual([result.items[0].sessionId, result.items[0].workItemId], ["child", "work"]);
    assert.deepEqual(result.recoveryActions, []);
    await assert.rejects(() => f.make().compensate(binding, { delegationId: result.id, expectedRevision: result.revision, idempotencyKey: "cleanup" }, proof), /uncertain creation/);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "Delegation control grantがSession作成後に取り消されると後続のWork/Turn effectを開始しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md" }
// fault = "sub-operation grantだけを検証して取り消されたDelegationの後続effectを実行する"
// observable = "Session ID保持、AUTHORITY_DENIED、work.create/turn.enqueue呼出なし"
// observation_boundary = "component-behavior"
// scope = "DelegationServiceのstep間認可。grant評価自体はcallback stub"
// lifecycle = "permanent"
// @end-test-value
test("control revocation stops subsequent delegation effects", async () => {
  const f = await fixture();
  try {
    f.revokeControlAfter("session.create");
    const result = await f.make().create(binding, request, proof);
    assert.equal(result.items[0].sessionId, "child");
    assert.equal(result.items[0].workItemId, null);
    assert.equal(result.items[0].error?.code, "AUTHORITY_DENIED");
    assert.equal(f.attempts.filter((call) => ["work.create", "turn.enqueue"].includes(call.operation)).length, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "execution read失敗でも所有DelegationのID一覧を返し、観測したterminal stateは再起動後も保持する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#部分成功とstep状態" }
// fault = "下位read拒否で全rowを隠す、またはcompleted観測を保存せず後のread拒否で失う"
// observable = "get/listのresource IDsとread error、再open後completed、追加turn.get呼出なし"
// observation_boundary = "component-behavior"
// scope = "Delegation projectionと実SQLite。execution ownerはstub"
// lifecycle = "permanent"
// @end-test-value
test("delegation readback survives execution read failure and persists completion", async () => {
  const f = await fixture();
  try {
    const active = await f.make().create(binding, request, proof);
    f.fail("turn.get");
    const read = await f.make().get(binding, { delegationId: active.id });
    assert.deepEqual(read.items.map((item) => item.executionId), ["execution"]);
    assert.equal(read.items[0].error?.code, "PROVIDER_DISABLED");
    assert.equal((await f.make().list(binding, { limit: 50 })).items[0].id, active.id);
    f.fail(null);
    f.setExecutionState("completed");
    const completed = await f.make().get(binding, { delegationId: active.id });
    assert.equal(completed.state, "completed");
    f.fail("turn.get");
    const calls = f.attempts.length;
    assert.equal((await f.reopen().get(binding, { delegationId: active.id })).state, "completed");
    assert.equal(f.attempts.length, calls);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "同じ既存Sessionの別Work委譲は取消と補償を妨げず、別executionが使う作成Workは取消前に保護する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#公開操作" }
// fault = "Session共有を全resource採用と誤認して自executionを停止不能にする、または別executionのWorkをcancelする"
// observable = "cancelled/compensated、turn.cancel呼出、adopted Workのwork.cancel未実行"
// observation_boundary = "component-behavior"
// scope = "実Delegation rowsとowner stubでのcleanup対象判定"
// lifecycle = "permanent"
// @end-test-value
test("shared sessions do not block cleanup but other executions protect adopted work", async () => {
  for (const adopted of [false, true]) {
    const f = await fixture();
    try {
      const plan = { ...request, items: [{ ...request.items[0], target: { kind: "existing" as const, sessionId: "child" } }] };
      const first = await f.make().create(binding, plan, proof);
      await f.make().create(binding, { ...plan, idempotencyKey: "other", dispatch: "prepare", items: [{ ...plan.items[0], work: { kind: "existing", workItemId: "different-work" } }] }, proof);
      if (adopted) f.setOtherExecutions([{ id: "other-execution", workItemId: "work", state: "running" }]);
      const canceled = await f.make().cancel(binding, { delegationId: first.id, expectedRevision: first.revision, idempotencyKey: "cancel" }, proof);
      assert.equal(canceled.state, "cancelled");
      const result = await f.make().compensate(binding, { delegationId: first.id, expectedRevision: canceled.revision, idempotencyKey: "compensate" }, proof);
      assert.equal(result.state, adopted ? "recovery_required" : "compensated");
      assert.equal(f.attempts.filter((call) => call.operation === "work.cancel").length, adopted ? 0 : 1);
      assert.equal(f.attempts.filter((call) => call.operation === "turn.cancel").length, 1);
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "別mutationを挟んでも使用済みkeyを別payloadへ使うと副作用前にconflictとなる"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#公開操作" }
// fault = "直近mutationだけのkey検証で古いkeyの別payload再利用を許す"
// observable = "IDEMPOTENCY_CONFLICTとowner呼出回数不変"
// observation_boundary = "component-behavior"
// scope = "Delegation mutationのkey契約と実SQLite保存"
// lifecycle = "permanent"
// @end-test-value
test("older mutation keys cannot be reused for another payload", async () => {
  const f = await fixture();
  try {
    const first = await f.make().create(binding, { ...request, dispatch: "prepare" }, proof);
    const started = await f.make().retry(binding, { delegationId: first.id, expectedRevision: first.revision, idempotencyKey: "K", dispatch: "enqueue" }, proof);
    const canceled = await f.make().cancel(binding, { delegationId: first.id, expectedRevision: started.revision, idempotencyKey: "J" }, proof);
    const calls = f.attempts.length;
    await assert.rejects(() => f.reopen().compensate(binding, { delegationId: first.id, expectedRevision: canceled.revision, idempotencyKey: "K" }, proof), (error: unknown) => error instanceof DelegationOperationError && error.error.code === "IDEMPOTENCY_CONFLICT");
    assert.equal(f.attempts.length, calls);
  } finally { await f.close(); }
});
