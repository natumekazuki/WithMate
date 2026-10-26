import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionGraphApplicationService, type ResolvedSessionGraphSession, type SessionGraphStore } from "../../src-electron/session-graph/session-graph-application-service.js";
import { SessionGraphRuntimeService } from "../../src-electron/session-graph/session-graph-runtime-service.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { getSessionGraphAgentRuntimeOperations } from "../../src-shared/session-graph/session-graph-operation-schema.js";
import type { SessionGraphIdentity, SessionGraphOperation, SessionGraphOperationResult, SessionGraphOwner, SessionGraphRequest } from "../../src-shared/session-graph/session-graph-contract.js";

function fixture() {
  const owner = { sessionId: "main", incarnationId: "incarnation" };
  let generation = "generation";
  const identities: SessionGraphIdentity[] = [
    { sessionId: "main", sessionTitle: "Main", role: "main" },
    { sessionId: "aux", sessionTitle: "Aux", role: "auxiliary", character: { id: "character", name: "Character" } },
  ];
  const calls: { recorder?: SessionGraphIdentity; actors?: SessionGraphIdentity[] }[] = [];
  const store: SessionGraphStore = { async execute<K extends SessionGraphOperation>(_owner: SessionGraphOwner, _operation: K, _request: SessionGraphRequest<K>, recorder?: SessionGraphIdentity, actors?: SessionGraphIdentity[]) {
    calls.push({ recorder, actors });
    return { status: "ok", revision: 1 } as SessionGraphOperationResult<K>;
  } };
  const app = new SessionGraphApplicationService({ getStore: () => store, resolveSession(id): ResolvedSessionGraphSession | null {
    const identity = identities.find((item) => item.sessionId === id);
    return identity ? { owner, identity, providerId: "codex", generation } : null;
  } });
  const registry = new AgentRuntimeBindingRegistry();
  const binding = registry.issueOrReuse({ actorSessionId: "aux", providerId: "codex", authoritySnapshot: { sessionGraphOwner: owner, characterId: "character" }, operationGrants: getSessionGraphAgentRuntimeOperations() });
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const runtime = new SessionGraphRuntimeService({ applicationService: app, bindingRegistry: registry, providerAgentRuntimeTurns: turns });
  return { app, registry, turns, runtime, binding, calls, identities, replaceGeneration() { generation = "replacement"; } };
}
const record = { id: "record", topicId: "topic", kind: "activity" as const, title: "Work", detail: "Details", scope: "scope", actor: { sessionId: "main" }, references: [] };

// @test-value v2
// kind = "invariant"
// claim = "AuxによるMain主体の記録はtrusted recorderとactorを別々に解決し、失効turnとscope偽装を拒否する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "callerがrecorderを偽装するか失効turnでMain Graphへ変更する"
// observable = "runtime応答と永続化境界へ渡されたidentityおよび呼出件数"
// observation_boundary = "public-boundary"
// scope = "session-graph-runtime"
// lifecycle = "permanent"
// impact = "共有Graphの帰属とSession間の権限境界を保護する"
// distinction = "型やschemaだけではtrusted bindingとturnの動的失効を検出できない"
// @end-test-value
test("Session Graph mutation uses trusted identities and active turn authority", async () => {
  const f = fixture();
  const turn = f.turns.begin({ actorSessionId: "aux", providerId: "codex" });
  const request = { method: "POST" as const, path: "/v1/session-graph/apply", transport: "mcp" as const, bindingReference: f.binding.bindingReference, turnCapability: turn.capability, body: { expectedRevision: 0, records: [record] } };
  assert.equal((await f.runtime.route({ ...request, body: { ...request.body, recordedBy: "main" } }))?.status, 400);
  assert.equal((await f.runtime.route(request))?.status, 200);
  assert.deepEqual(f.calls, [{ recorder: f.identities[1], actors: [f.identities[0]] }]);
  f.turns.end(turn);
  assert.equal((await f.runtime.route(request))?.status, 401);
  assert.equal(f.calls.length, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "同じparentに解決できないactor参照を保存境界へ渡さない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "任意Session IDをactorとして登録し他parentへ誤帰属させる"
// observable = "applicationのrejectとstore呼出件数"
// observation_boundary = "public-boundary"
// scope = "session-graph-application"
// lifecycle = "permanent"
// impact = "他Sessionのidentity偽装を防ぐ"
// distinction = "ID文字列schemaは同parent所属を保証できない"
// @end-test-value
test("Session Graph rejects unresolved actor references before storage", async () => {
  const f = fixture();
  await assert.rejects(f.app.executeTrusted("aux", "apply", { expectedRevision: 0, records: [{ ...record, actor: { sessionId: "other-parent" } }] }, () => true), /outside the parent/);
  assert.equal(f.calls.length, 0);
});

// @test-value v2
// kind = "invariant"
// claim = "非同期scope解決中にstorage generationが切り替わると旧要求は新storeへ適用されない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "await後のgeneration再検証を省きreset前の要求を新Graphへ保存する"
// observable = "applicationのrejectとstore呼出件数"
// observation_boundary = "public-boundary"
// scope = "session-graph-application"
// lifecycle = "permanent"
// impact = "storage reset後のデータへ旧要求が混入することを防ぐ"
// distinction = "型検査では非同期中のgeneration切替を観測できない"
// @end-test-value
test("Session Graph generation replacement rejects an in-flight request before storage", async () => {
  let resolutions = 0;
  let calls = 0;
  const store: SessionGraphStore = { async execute<K extends SessionGraphOperation>() {
    calls++;
    return { status: "ok", revision: 1 } as SessionGraphOperationResult<K>;
  } };
  const app = new SessionGraphApplicationService({ getStore: () => store, async resolveSession() {
    resolutions++;
    return { owner: { sessionId: "main", incarnationId: "incarnation" }, identity: { sessionId: "main", sessionTitle: "Main", role: "main" as const }, providerId: "codex", generation: resolutions === 1 ? "old" : "new" };
  } });
  await assert.rejects(app.executeTrusted("main", "apply", { expectedRevision: 0 }, () => true), /authority changed/);
  assert.equal(calls, 0);
});
