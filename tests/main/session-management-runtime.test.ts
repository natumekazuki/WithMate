import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { SessionManagementApplication } from "../../src-electron/session/session-management-application.js";
import { getSessionAgentRuntimeOperations } from "../../src-shared/session/session-management-contract.js";
// @test-value v2
// kind = "security"
// claim = "Session APIは実bindingの保存identityと現在Turnを要求し古いTurnと失効bindingを拒否する"
// oracle = { type = "contract", ref = "GitHub #835 selfと実actor・Turn・期限切れ接続の受入条件" }
// fault = "tokenだけで古いTurnや別保存identityを使ってSession APIを実行する"
// observable = "selfの実Sessionとbinding失効後・異なるTurnの401結果"
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
  const application = new SessionManagementApplication({
    listSessions: async () => [
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
      },
    ],
    currentTurn: async () => ({
      turnId: "withmate-turn",
      receipt: null,
      origin: null,
    }),
    updateMetadata: unused,
    directories: unused,
    enqueue: unused,
    getReceipt: unused,
    cancelReceipt: unused,
    stopTurn: unused,
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
  turns.end(turn);
  assert.equal((await runtime.route(request))?.status, 401);
  bindings.revokeSession("actual");
  assert.equal((await runtime.route(request))?.status, 401);
});
