import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { createSessionManagementScopeReader, SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { SessionManagementApplication } from "../../src-electron/session/session-management-application.js";
import { getSessionAgentRuntimeOperations } from "../../src-shared/session/session-management-contract.js";
import { fixtureSessionManagementScope } from "./fixtures/session-management-scope.js";
// @test-value v2
// kind = "security"
// claim = "Session APIは実binding・現在Turnを要求し、失効bindingや交代済みstoreからselfを返さない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api; https://app.notion.com/4239d4b6f2628041b656c1473047eafe#受け入れ条件" }
// fault = "終了・別Turnや保存identityの読取中のbinding失効、store交代を無視する"
// observable = "selfの実Session、401と旧store失敗、および失効後にcurrentTurnを取得しないこと"
// observation_boundary = "public-boundary"
// scope = "session-management-runtime"
// lifecycle = "permanent"
// @end-test-value
test("normal runtime requires captured saved identity and active provider Turn", async () => {
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const binding = bindings.issueOrReuse({
    actorSessionId: "actual",
    providerId: "codex",
    operationGrants: getSessionAgentRuntimeOperations(),
    authoritySnapshot: {
      sessionIdentity: {
        kind: "main",
        sessionId: "actual",
        incarnationId: "actual-v1",
      },
    },
  });
  const turn = turns.begin({ actorSessionId: "actual", providerId: "codex" });
  const unused = async () => {
    throw new Error("read only");
  };
  let beforeScopeReturn: (() => Promise<void>) | undefined;
  let currentTurnReads = 0;
  const readFixtureScope = fixtureSessionManagementScope(() => [
    {
      id: "actual",
      incarnationId: "actual-v1",
      kind: "main",
      role: "standalone",
      sessionRole: "standalone",
      rootSessionId: "actual",
      parentSessionId: null,
      createdBySessionId: null,
      mainSessionId: "actual",
      mainIncarnationId: "actual-v1",
      title: "actual",
      description: "",
      runState: "running",
      provider: "codex",
      workspacePath: "C:/workspace",
    },
  ]);
  const readSessionManagementScope: typeof readFixtureScope = async (actor, selection) => {
    const scope = await readFixtureScope(actor, selection);
    await beforeScopeReturn?.();
    return scope;
  };
  let owner = { storageWorker: { stores: { session: { readSessionManagementScope } } } };
  const application = new SessionManagementApplication({
    operatingPolicy: unused,
    readSessionScope: createSessionManagementScopeReader(() => owner),
    currentTurn: async () => {
      currentTurnReads++;
      return { turnId: "withmate-turn", receipt: null, origin: null };
    },
    updateMetadata: unused,
    directories: unused,
    enqueue: unused,
    getReceipt: unused,
    cancelReceipt: unused,
    stopTurn: unused,
    steer: unused,
    readExecution: unused,
    crewFolder: async () => ({
      rootSessionId: "actual",
      path: "crew-files/actual",
    }),
    coordinate: unused,
    createChild: unused,
    catalog: unused,
  });
  const runtime = new SessionManagementRuntimeService({
    application,
    bindingRegistry: bindings,
    providerAgentRuntimeTurns: turns,
  });
  const request = {
    method: "POST" as const,
    path: "/v1/session/self",
    body: {},
    transport: "mcp" as const,
    bindingReference: binding.bindingReference,
    turnCapability: turn.capability,
  };
  const result = await runtime.route(request);
  assert.equal(result?.status, 200);
  assert.equal(
    (result?.value as { session: { id: string } }).session.id,
    "actual",
  );
  assert.equal(
    (await runtime.route({ ...request, turnCapability: "other-turn" }))?.status,
    401,
  );
  function holdScope() {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    beforeScopeReturn = () => { started.resolve(); return finish.promise; };
    return { started: started.promise, finish: finish.resolve };
  }
  const storeRead = holdScope();
  const staleStore = runtime.route(request);
  await storeRead.started;
  owner = { ...owner };
  storeRead.finish();
  assert.equal((await staleStore)?.status, 500);
  assert.equal(currentTurnReads, 1);
  turns.end(turn);
  assert.equal((await runtime.route(request))?.status, 401);

  const nextTurn = turns.begin({ actorSessionId: "actual", providerId: "codex" });
  const boundRead = holdScope();
  const currentRequest = { ...request, turnCapability: nextTurn.capability };
  const inFlight = runtime.route(currentRequest);
  await boundRead.started;
  bindings.revokeSession("actual");
  boundRead.finish();
  assert.equal((await inFlight)?.status, 401);
  assert.equal(currentTurnReads, 1);
  assert.equal((await runtime.route(currentRequest))?.status, 401);
  turns.end(nextTurn);
});
