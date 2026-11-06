import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionGraphApplicationService, type ResolvedSessionGraphSession, type SessionGraphStore } from "../../src-electron/session-graph/session-graph-application-service.js";
import { SessionGraphRuntimeService } from "../../src-electron/session-graph/session-graph-runtime-service.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { getSessionGraphAgentRuntimeOperations } from "../../src-shared/session-graph/session-graph-operation-schema.js";
import type { SessionGraphIdentity, SessionGraphOwner } from "../../src-shared/session-graph/session-graph-contract.js";
import type { SessionGraphStorageOperation, SessionGraphStorageRequest, SessionGraphStorageResult } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";

function fixture() {
  const owner = { sessionId: "main", incarnationId: "incarnation" };
  let generation = "generation";
  const identities: SessionGraphIdentity[] = [
    { sessionId: "main", sessionTitle: "Main", role: "main", character: { id: "character", name: "Character" } },
    { sessionId: "aux", sessionTitle: "Aux", role: "auxiliary", character: { id: "character", name: "Character" } },
    { sessionId: "other-parent", sessionTitle: "Other", role: "main", character: { id: "character", name: "Character" } },
    { sessionId: "worker", sessionTitle: "Worker", role: "main", character: { id: "worker-character", name: "Worker" } },
  ];
  const calls: { request: SessionGraphStorageRequest<SessionGraphStorageOperation>; recorder?: SessionGraphIdentity; actors?: SessionGraphIdentity[] }[] = [];
  const owners: SessionGraphOwner[] = [];
  const store: SessionGraphStore = { async execute<K extends SessionGraphStorageOperation>(_owner: SessionGraphOwner, _operation: K, _request: SessionGraphStorageRequest<K>, recorder?: SessionGraphIdentity, actors?: SessionGraphIdentity[]) {
    calls.push({ request: _request, recorder, actors });
    owners.push(_owner);
    return { status: "ok", revision: 1 } as SessionGraphStorageResult<K>;
  } };
  const app = new SessionGraphApplicationService({ getStore: () => store, resolveSession(id, source): ResolvedSessionGraphSession | null {
    const identity = identities.find((item) => item.sessionId === id);
    if (source && (source.kind !== identity?.role || (source.incarnationId && source.incarnationId !== "incarnation"))) return null;
    return identity ? { owner: id === "other-parent" ? { ...owner, sessionId: id } : owner, identity, providerId: "codex", generation, source: { kind: identity.role, incarnationId: "incarnation" } } : null;
  } });
  const registry = new AgentRuntimeBindingRegistry();
  const binding = registry.issueOrReuse({ actorSessionId: "aux", providerId: "codex", authoritySnapshot: { sessionGraphOwner: owner, sessionGraphSource: { kind: "auxiliary", incarnationId: "incarnation" }, characterId: "character" }, operationGrants: getSessionGraphAgentRuntimeOperations() });
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const runtime = new SessionGraphRuntimeService({ applicationService: app, bindingRegistry: registry, providerAgentRuntimeTurns: turns });
  return { app, registry, turns, runtime, binding, calls, owners, identities, replaceGeneration() { generation = "replacement"; } };
}
const record = { id: "record", topicId: "topic", kind: "activity" as const, title: "Work", detail: "Details", scope: "scope", origin: { type: "agent" as const }, actor: { sessionId: "main" }, references: [] };

// @test-value v2
// kind = "invariant"
// claim = "Auxは明示担当とtrusted recorderを別々に解決し、担当省略は保存層へ保持して渡し、失効turn・bindingとrecorder偽装を拒否する"
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
  assert.deepEqual(f.calls, [{ request: request.body, recorder: f.identities[1], actors: [f.identities[0]] }]);
  const { actor: _actor, ...selfRecord } = record;
  const selfRequest = { ...request, body: { expectedRevision: 1, records: [{ ...selfRecord, origin: { type: "user" as const } }] } };
  assert.equal((await f.runtime.route(selfRequest))?.status, 200);
  assert.deepEqual(f.calls[1], { request: selfRequest.body, recorder: f.identities[1], actors: [] });
  f.turns.end(turn);
  assert.equal((await f.runtime.route(request))?.status, 401);
  const activeTurn = f.turns.begin({ actorSessionId: "aux", providerId: "codex" });
  f.registry.revokeSession("aux");
  assert.equal((await f.runtime.route({ ...request, turnCapability: activeTurn.capability }))?.status, 401);
  f.turns.end(activeTurn);
  assert.equal(f.calls.length, 2);
});

// @test-value v2
// kind = "invariant"
// claim = "存在しないactor、同Characterの別parent actor、親Graph不一致のbindingを保存境界へ渡さない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "任意Session IDをactorとして登録し他parentへ誤帰属させる"
// observable = "applicationのreject、runtimeの403応答とstore呼出件数"
// observation_boundary = "public-boundary"
// scope = "session-graph-application"
// lifecycle = "permanent"
// impact = "他Sessionのidentity偽装を防ぐ"
// distinction = "ID文字列schemaは同parent所属を保証できない"
// @end-test-value
test("Session Graph rejects unresolved actor references before storage", async () => {
  const f = fixture();
  for (const sessionId of ["missing", "other-parent"]) {
    await assert.rejects(f.app.executeTrusted("aux", "apply", { expectedRevision: 0, records: [{ ...record, actor: { sessionId } }] }, () => true), /outside the parent/);
  }
  const wrongParent = f.registry.issueOrReuse({ actorSessionId: "aux", providerId: "codex",
    authoritySnapshot: { sessionGraphOwner: { sessionId: "other-parent", incarnationId: "incarnation" }, sessionGraphSource: { kind: "auxiliary", incarnationId: "incarnation" }, characterId: "character" },
    operationGrants: getSessionGraphAgentRuntimeOperations() });
  const turn = f.turns.begin({ actorSessionId: "aux", providerId: "codex" });
  assert.equal((await f.runtime.route({ method: "POST", path: "/v1/session-graph/apply", transport: "mcp",
    bindingReference: wrongParent.bindingReference, turnCapability: turn.capability,
    body: { expectedRevision: 0, records: [record] } }))?.status, 403);
  f.turns.end(turn);
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
  const store: SessionGraphStore = { async execute<K extends SessionGraphStorageOperation>() {
    calls++;
    return { status: "ok", revision: 1 } as SessionGraphStorageResult<K>;
  } };
  const app = new SessionGraphApplicationService({ getStore: () => store, async resolveSession() {
    resolutions++;
    return { owner: { sessionId: "main", incarnationId: "incarnation" }, source: { kind: "main" as const, incarnationId: "incarnation" }, identity: { sessionId: "main", sessionTitle: "Main", role: "main" as const }, providerId: "codex", generation: resolutions === 1 ? "old" : "new" };
  } });
  await assert.rejects(app.executeTrusted("main", "apply", { expectedRevision: 0 }, () => true), /authority changed/);
  assert.equal(calls, 0);
});

// @test-value v2
// kind = "invariant"
// claim = "通常WorkerとAuxは自Crewへ書けるが他Crewは明示した起点incarnationへの読取だけを許可し、callerと担当の帰属を保持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/921" }
// fault = "読取先をcallerへ置換する、他Crewへ書く、または古い対象・caller incarnationを受理する"
// observable = "runtime応答、保存境界のowner・recorder・actorと呼出件数"
// observation_boundary = "public-boundary"
// scope = "Crew Graph runtime read/write boundary"
// lifecycle = "permanent"
// impact = "Crew混合と誤帰属を防止する"
// distinction = "schemaや型ではbinding・保存所属・対象寿命の組合せを検査できない"
// @end-test-value
test("Crew Graph resolves explicit foreign reads without changing write authority", async () => {
  const f = fixture();
  const foreign = { sessionId: "other-parent", incarnationId: "incarnation" };
  const read = { method: "POST" as const, path: "/v1/session-graph/get", transport: "mcp" as const,
    bindingReference: f.binding.bindingReference, body: { ids: ["record"], graphOwner: foreign } };
  assert.equal((await f.runtime.route(read))?.status, 200);
  assert.deepEqual(f.owners[0], foreign);
  assert.deepEqual(f.calls[0].recorder, f.identities[1]);
  assert.equal((await f.runtime.route({ ...read, body: { ...read.body, graphOwner: { ...foreign, incarnationId: "old" } } }))?.status, 409);
  assert.equal((await f.runtime.route({ ...read, body: { ...read.body, graphOwner: { sessionId: "worker", incarnationId: "incarnation" } } }))?.status, 409);
  assert.equal((await f.runtime.route({ ...read, path: "/v1/session-graph/apply", body: { expectedRevision: 0, graphOwner: foreign } }))?.status, 400);
  const workerBinding = f.registry.issueOrReuse({ actorSessionId: "worker", providerId: "codex",
    authoritySnapshot: { sessionGraphOwner: { sessionId: "main", incarnationId: "incarnation" }, sessionGraphSource: { kind: "main", incarnationId: "incarnation" }, characterId: "worker-character" }, operationGrants: getSessionGraphAgentRuntimeOperations() });
  const turn = f.turns.begin({ actorSessionId: "worker", providerId: "codex" });
  assert.equal((await f.runtime.route({ ...read, bindingReference: workerBinding.bindingReference, turnCapability: turn.capability,
    path: "/v1/session-graph/apply", body: { expectedRevision: 0, records: [{ ...record, actor: { sessionId: "aux" } }] } }))?.status, 200);
  assert.deepEqual(f.owners.at(-1), { sessionId: "main", incarnationId: "incarnation" });
  assert.deepEqual(f.calls.at(-1)?.recorder, f.identities[3]);
  assert.deepEqual(f.calls.at(-1)?.actors, [f.identities[1]]);
  f.turns.end(turn);
  const stale = f.registry.issueOrReuse({ actorSessionId: "worker", providerId: "codex", authoritySnapshot: {
    sessionGraphOwner: { sessionId: "main", incarnationId: "incarnation" }, sessionGraphSource: { kind: "main", incarnationId: "old" }, characterId: "worker-character" }, operationGrants: getSessionGraphAgentRuntimeOperations() });
  assert.equal((await f.runtime.route({ ...read, bindingReference: stale.bindingReference }))?.status, 403);
  assert.equal(f.calls.length, 2);
});
