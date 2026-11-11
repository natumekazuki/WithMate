import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { buildWithMateMemoryCli, buildWithMateGlossaryCli, buildWithMateSessionGraphCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { getBackgroundMemoryReadOperations } from "../../src-shared/agent-runtime/background-memory-read.js";
import { BACKGROUND_REGISTRATION_OPERATIONS, backgroundMemoryToolOperations, getBackgroundReadOperations } from "../../src-shared/agent-runtime/background-operations.js";
import { AFFECT_SCHEMA_VERSION } from "../../src-shared/character-affect/affect-contract.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION } from "../../src-shared/character-context/character-context-contract.js";
import type { BackgroundSourceRef } from "../../src-shared/session/background-source-snapshot.js";
import { MEMORY_V6_SCHEMA_VERSION, type MemoryTargetSelector } from "../../src-shared/memory/memory-contract.js";
import { createLocalUserMemoryPrincipal } from "../../src-electron/memory/memory-v6-permission.js";
import { getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory/memory-v6-http-server.js";
import { resolveMemoryV6ProjectCandidate } from "../../src-electron/memory/memory-v6-project-resolver.js";
import { backgroundMemoryRegistrationHandlers } from "../../src-electron/memory/background-memory-registration.js";
import { GlossaryApplicationService, projectGlossaryCheckoutAuthority } from "../../src-electron/glossary/glossary-application-service.js";
import { getGlossaryAgentRuntimeOperations } from "../../src-shared/glossary/glossary-operation-schema.js";
import { getSessionGraphAgentRuntimeOperations } from "../../src-shared/session-graph/session-graph-operation-schema.js";
import { callWithMateMemoryRuntime } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../../src-electron/platform/memory/memory-runtime-exchange.js";
import { backgroundHistoryFixture as fixture, owner } from "../helpers/background-history-fixture.js";

const execFileAsync = promisify(execFile);
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Binding = ReturnType<Fixture["project"]>;
let artifactDirectory: string;
let memoryCli: string;
let glossaryCli: string;
let graphCli: string;
before(async () => {
  artifactDirectory = await mkdtemp(join(tmpdir(), "withmate-background-read-cli-"));
  [memoryCli, glossaryCli, graphCli] = await Promise.all([
    buildWithMateMemoryCli(artifactDirectory), buildWithMateGlossaryCli(artifactDirectory), buildWithMateSessionGraphCli(artifactDirectory),
  ]);
});
after(async () => { await rm(artifactDirectory, { recursive: true, force: true }); });

const projectTarget = { owner: "project", scope: "project", project: { type: "id", id: "project-a" } } as const satisfies MemoryTargetSelector;
const characterTarget = { owner: "character", scope: "character", character: { type: "id", id: "character" } } as const satisfies MemoryTargetSelector;
const publicProject = { kind: "project", project: { type: "id", id: "project-a" } };
const publicOtherProject = { kind: "project", project: { type: "id", id: "project-b" } };

async function seed(f: Fixture) {
  for (const id of ["project-a", "project-b"]) f.db.prepare(`INSERT INTO project_scopes_v6
    (id,project_type,project_key,workspace_path,display_name,created_at,updated_at) VALUES (?,'directory',?,?,?,'now','now')`)
    .run(id, id, join(f.directory, id), id);
  f.db.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES ('other-character','Other','now','now')").run();
  const local = createLocalUserMemoryPrincipal();
  const append = async (target: MemoryTargetSelector, title: string) => {
    const result = await f.memory.append(local, { schemaVersion: MEMORY_V6_SCHEMA_VERSION, target, kind: "note", title,
      body: `${title} body`, preview: `${title} preview`, tags: [{ type: "topic", value: "background" }] });
    assert.ok(!("error" in result), JSON.stringify(result));
    return result.entry.id;
  };
  const project = await append(projectTarget, "saved project needle");
  const character = await append(characterTarget, "saved character needle");
  const outside = await append({ ...projectTarget, project: { type: "id", id: "project-b" } }, "private outside needle");
  await append({ owner: "user", scope: "global" }, "private global needle");
  const otherCharacter = await append({ owner: "character", scope: "character", character: { type: "id", id: "other-character" } }, "private character needle");
  const forgotten = await append(projectTarget, "forgotten secret needle");
  const removed = await f.memory.forget(local, { schemaVersion: MEMORY_V6_SCHEMA_VERSION, target: projectTarget,
    entryIds: [forgotten], reason: "privacy" });
  assert.ok(!("error" in removed), JSON.stringify(removed));
  return { project, character, outside, otherCharacter, forgotten };
}

function start(f: Fixture, purpose: "affect" | "target-memory" | "character-memory" = "target-memory") {
  return f.started("main", "claude", purpose, undefined, getBackgroundMemoryReadOperations(), {
    memoryTargets: [projectTarget, characterTarget], allowedProjectIds: ["project-a"],
  });
}

async function cli(f: Fixture, binding: Binding, command: string, input: Record<string, unknown>,
  overrides: NodeJS.ProcessEnv = {}, artifact = memoryCli) {
  const result = await execFileAsync(process.execPath, [artifact, command, "--json", JSON.stringify(input)], {
    cwd: f.directory, env: { ...f.cliEnv(binding), ...overrides }, timeout: 15_000,
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string; stderr: string }) => {
    assert.equal(typeof error.code, "number", error.stderr);
    return { code: error.code, stdout: error.stdout };
  });
  return { code: result.code, value: JSON.parse(result.stdout) as Record<string, any> };
}

async function direct(f: Fixture, binding: Binding, route: string, body: Record<string, unknown>, reference = binding.bindingReference, capability = binding.turnCapability) {
  const extension = route.startsWith("glossary/") || route.startsWith("session-graph/");
  return callWithMateMemoryRuntime(f.connection, { method: "POST", path: `/v1/${route}`,
    body: route.startsWith("glossary/") ? { schemaVersion: "withmate-glossary-v1", selector: { kind: "primary" }, ...body }
      : extension ? body : { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...body },
  }, { bindingReference: reference, turnCapability: capability, signal: AbortSignal.timeout(5_000),
    ...(extension ? { exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } : {}) });
}

async function unregisteredProject(f: Fixture) {
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", f.directory], { windowsHide: true });
  await execFileAsync("git", ["-C", f.directory, "config", "remote.origin.url", "https://example.test/new-project.git"], { windowsHide: true });
  const candidate = resolveMemoryV6ProjectCandidate(f.directory);
  assert.ok(candidate?.admission);
  return candidate;
}

function scopeCount(f: Fixture) {
  return f.db.prepare("SELECT COUNT(*) AS count FROM project_scopes_v6").get()!.count;
}

function ordinaryBinding(f: Fixture, sessionId: string, actorSource: BackgroundSourceRef = f.scope(sessionId).history.source) {
  const input = { actorSessionId: sessionId, actorSource, providerId: "codex", authoritySnapshot: {
    userId: "local-user", characterId: "character", allowedProjectIds: [],
  }, operationGrants: getMemoryV6AgentRuntimeOperations() };
  const issued = f.bindings.issueOrReuse(input);
  const handle = f.turns.begin({ actorSessionId: sessionId, providerId: "codex" });
  const projected = { ...issued, turnCapability: handle.capability, memoryRuntimeOwner: owner };
  return { input, handle, binding: { ...projected, managedMcp: f.host.issue(projected, handle, new AbortController().signal) } };
}

// @test-value v2
// kind = "contract"
// claim = "通常AuxiliaryのMCP/CLIは同名MainからAffect read/writeとMemoryの保存ownerを分離し、実sourceのcontext・inspect・appraise・correct・resetを同じ状態へ反映する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "通常bindingからAuxiliary sourceが欠落してMainへ読取/保存する、関連mutationだけsourceが届かない、episodeや一般Memoryの出典をMainへstampする"
// observable = "独立したAux/Main event ID、両入口のcontext/inspect、appraise/correct/reset後の実DB owner、Affect連動episodeと一般Memory/episode出典、Main記録の不変"
// observation_boundary = "public-boundary"
// scope = "通常bindingのmanaged MCP/配布CLIからHTTP/Character application/実Memory Worker保存まで"
// lifecycle = "permanent"
// impact = "AuxiliaryがAffectを読めないか別会話の状態・保存記録を変更する"
// distinction = "背景登録testは用途handlerがsourceを補完し、通常Mainのadapter testはAuxiliary物理ownerを扱わない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("通常AuxiliaryのMemory/Affect公開操作は同名Mainと実ownerを分離する", async () => {
  const f = await fixture(undefined, undefined, () => new Date("2026-11-01T01:00:00.000Z"));
  let normal: ReturnType<typeof ordinaryBinding> | undefined;
  try {
    f.db.prepare(`INSERT INTO sessions_v6(id,incarnation_id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES ('aux','same-name-main','Main alias','active','codex',1,'test','on-request','character','{}','now','now','now')`).run();
    const event = { schemaVersion: AFFECT_SCHEMA_VERSION, layer: "session" as const, targetType: "task" as const, targetId: "aux-event",
      family: "interest" as const, value: { label: "Auxiliary interest", valence: 0.3 }, intensity: 0.8,
      reason: "saved reason", evidence: "saved evidence", occurredAt: "2026-11-01T00:00:00.000Z", idempotencyKey: "aux-event" };
    const aux = await f.memoryWorker.affectStorage.recordEvent({ ...event, characterId: "character", userId: "local-user", sessionId: "aux" },
      { sessionSource: f.scope("aux").history.source });
    const main = await f.memoryWorker.affectStorage.recordEvent({ ...event, targetId: "main-event", idempotencyKey: "main-event",
      characterId: "character", userId: "local-user", sessionId: "aux" });
    const mainBefore = f.db.prepare("SELECT * FROM character_affect_events_v6 WHERE id = ?").get(main.event.id);
    normal = ordinaryBinding(f, "aux");
    const { binding } = normal, { client } = await f.connect(binding, "memoryUrl");
    const read = async () => {
      const mcp = await client.callTool({ name: "character_affect.inspect", arguments: {} });
      const child = await cli(f, binding, "affect-inspect", {});
      assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
      assert.equal(child.code, 0, JSON.stringify(child.value));
      assert.deepEqual(mcp.structuredContent, child.value);
      return child.value;
    };
    const before = await read();
    assert.deepEqual(before.events.map((item: { id: string }) => item.id), [aux.event.id]);
    const contextMcp = await client.callTool({ name: "character_context.get", arguments: { memoryLimit: 0 } });
    const contextCli = await cli(f, binding, "context-get", { memoryLimit: 0 });
    assert.equal(contextMcp.isError, undefined, JSON.stringify(contextMcp));
    assert.equal(contextCli.code, 0, JSON.stringify(contextCli.value));
    assert.deepEqual(contextMcp.structuredContent, contextCli.value);
    assert.deepEqual(contextCli.value.affect.effective.map((item: { targetId: string }) => item.targetId), ["aux-event"]);
    const appended = await client.callTool({ name: "character_affect.appraise", arguments: {
      expectedVersion: before.version.version, candidates: [
        { ...event, targetId: "new-aux", idempotencyKey: "new-aux" },
        { ...event, targetId: "linked-aux", idempotencyKey: "linked-aux", memoryEpisode: { title: "Linked Auxiliary episode",
          body: "Auxiliary linked observation", preview: "Auxiliary linked observation", salience: 0.8 } },
      ],
    } });
    assert.equal(appended.isError, undefined, JSON.stringify(appended));
    const afterAppend = await read(), added = afterAppend.events.find((item: { targetId: string }) => item.targetId === "new-aux");
    assert.ok(added);
    assert.ok(afterAppend.events.find((item: { targetId: string }) => item.targetId === "linked-aux")?.memoryEntryId);
    const corrected = await cli(f, binding, "affect-correct", { eventId: added.id, expectedVersion: afterAppend.version.version,
      explicitUserRequest: true, reason: "Correct Auxiliary observation", replacement: { ...event,
        targetId: "corrected-aux", occurredAt: "2026-11-01T00:01:00.000Z", idempotencyKey: "corrected-aux" } });
    assert.equal(corrected.code, 0, JSON.stringify(corrected.value));
    assert.ok((await read()).events.some((item: { targetId: string }) => item.targetId === "corrected-aux"));
    const reset = await client.callTool({ name: "character_affect.reset", arguments: { layer: "session",
      expectedVersion: corrected.value.version, explicitUserRequest: true, reason: "Reset Auxiliary session",
      resetAt: "2026-11-01T00:02:00.000Z", idempotencyKey: "reset-aux" } });
    assert.equal(reset.isError, undefined, JSON.stringify(reset));
    const afterReset = await cli(f, binding, "context-get", { memoryLimit: 0 });
    assert.equal(afterReset.code, 0, JSON.stringify(afterReset.value));
    assert.deepEqual(afterReset.value.affect.effective, []);
    for (const [command, input] of [
      ["append", { target: { kind: "character" }, kind: "note", title: "Auxiliary note", body: "Auxiliary note body",
        preview: "Auxiliary note", idempotencyKey: "aux-note" }],
      ["character-memory-append-episode", { idempotencyKey: "aux-episode", episode: { title: "Auxiliary episode",
        body: "An Auxiliary observation", preview: "Auxiliary observation", motif: "owner", observedFact: "The Auxiliary completed a check." } }],
    ] as const) {
      const saved = await cli(f, binding, command, input);
      assert.equal(saved.code, 0, JSON.stringify(saved.value));
      const row = f.db.prepare("SELECT source_session_id,source_auxiliary_session_id FROM memory_entries_v6 WHERE id = ?").get(saved.value.entry.id);
      assert.deepEqual({ ...row }, { source_session_id: null, source_auxiliary_session_id: "aux" });
    }
    assert.deepEqual(f.db.prepare("SELECT * FROM character_affect_events_v6 WHERE id = ?").get(main.event.id), mainBefore);
    assert.ok(f.db.prepare("SELECT 1 FROM character_affect_resets_v6 WHERE auxiliary_session_id = 'aux' AND session_id IS NULL").get());
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6 WHERE id != ? AND auxiliary_session_id IS NOT 'aux'")
      .get(main.event.id)!.count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6 WHERE source_session_id IS NOT NULL OR source_auxiliary_session_id IS NOT 'aux'").get()!.count, 0);
    f.turns.end(normal.handle);
    normal = ordinaryBinding(f, "aux", { kind: "main", sessionId: "aux", incarnationId: "same-name-main" });
    const mainRead = await cli(f, normal.binding, "affect-inspect", {});
    assert.equal(mainRead.code, 0, JSON.stringify(mainRead.value));
    assert.deepEqual(mainRead.value.events.map((item: { id: string }) => item.id), [main.event.id]);
  } finally { if (normal) f.turns.end(normal.handle); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "通常Auxiliary bindingは本人/親の再作成と削除を拒否し、sourceが変わった次回発行は旧bindingを再利用しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "通常bindingで現在sourceを検証しない、親identityを無視する、Auxiliary削除後に同名Mainへfallbackする、または古いsourceのbindingを再利用する"
// observable = "現在sourceでのMCP/CLI成功、DBの本人/親incarnation変更・削除後の両入口拒否、次回binding referenceと旧referenceの失効"
// observation_boundary = "public-boundary"
// scope = "通常binding発行/再利用とHTTPの実actor source照合"
// lifecycle = "permanent"
// impact = "置換後の会話へ旧Auxiliaryの読取/保存権限を持ち越す"
// distinction = "背景はscopeを別管理し、既存通常binding testは会話kind/親incarnationを持たない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("通常Auxiliaryは現在sourceを照合し再作成時にbindingを再発行する", async () => {
  for (const change of ["self", "parent", "delete"] as const) {
    const f = await fixture();
    let normal: ReturnType<typeof ordinaryBinding> | undefined;
    try {
      normal = ordinaryBinding(f, "aux");
      const { binding, input } = normal, { client } = await f.connect(binding, "memoryUrl");
      assert.equal(f.bindings.issueOrReuse(input).bindingReference, binding.bindingReference);
      assert.equal((await client.callTool({ name: "character_affect.inspect", arguments: {} })).isError, undefined);
      assert.equal((await cli(f, binding, "affect-inspect", {})).code, 0);
      if (change === "self") f.db.prepare("UPDATE auxiliary_sessions SET created_at = 'recreated' WHERE id = 'aux'").run();
      else if (change === "parent") f.db.prepare("UPDATE sessions_v6 SET incarnation_id = 'recreated' WHERE id = 'main'").run();
      else f.db.prepare("DELETE FROM auxiliary_sessions WHERE id = 'aux'").run();
      assert.equal((await client.callTool({ name: "character_affect.inspect", arguments: {} })).isError, true);
      const child = await cli(f, binding, "affect-inspect", {});
      assert.notEqual(child.code, 0);
      assert.equal("events" in child.value, false);
      if (change !== "delete") {
        const next = f.bindings.issueOrReuse({ ...input, actorSource: f.scope("aux").history.source });
        assert.notEqual(next.bindingReference, binding.bindingReference);
        assert.equal(f.bindings.resolveIdentity(binding.bindingReference).ok, false);
      }
    } finally { if (normal) f.turns.end(normal.handle); await f.close(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "背景全用途のinspectはMCP/CLIで実Main/Auxiliaryのsession記録と同Characterのrelationshipだけを読み、caller identityと未接続mutationを拒否して保存状態を変えない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#背景memory-read" }
// fault = "inspectの公開とgrantが食い違う、AuxiliaryをMainとして読む、別Character/会話のsession記録を返す、広いgrantで用途やmutation制限を迂回する"
// observable = "公開tool、独立した保存済みtarget ID集合、MCP/CLI応答一致、拒否応答、Affect保存table snapshot"
// observation_boundary = "public-boundary"
// scope = "managed MCP/配布CLIから用途binding、HTTP、実Affect application/Workerまで"
// lifecycle = "permanent"
// impact = "背景Affectが履歴を読めないか、他会話/Characterの記録を漏らし、読取で保存状態を変える"
// distinction = "通常inspectとstorage単体testでは背景tool公開・用途grant・trusted sourceの伝播を通らない。共用fixtureとCLI buildで両入口を検証する"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("背景Affect inspectはMain/Auxiliaryの実ownerをMCP/CLIで読み権限境界を保つ", async () => {
  const f = await fixture();
  try {
    f.db.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES ('private-character','Private','now','now')").run();
    f.db.prepare(`INSERT INTO sessions_v6(id,incarnation_id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES ('aux','private-inc','Same-name Main','active','codex',1,'test','on-request','private-character','{}','now','now','now')`).run();
    for (const [sessionId, targetId, layer, characterId, auxiliary] of [
      ["main", "main-event", "session", "character", false],
      ["aux", "aux-event", "session", "character", true],
      ["other", "other-session-event", "session", "character", false],
      ["other", "shared-relationship", "relationship", "character", false],
      ["aux", "private-event", "session", "private-character", false],
    ] as const) {
      await f.memoryWorker.affectStorage.recordEvent({ schemaVersion: AFFECT_SCHEMA_VERSION, characterId, userId: "local-user",
        sessionId, layer, targetType: layer === "relationship" ? "user" : "task", targetId, family: "interest",
        value: { label: targetId, valence: 0.3 }, intensity: 0.4, reason: "saved reason", evidence: "saved evidence",
        occurredAt: "2026-11-01T00:00:00.000Z", idempotencyKey: targetId },
        auxiliary ? { sessionSource: f.scope("aux").history.source } : undefined);
    }
    const snapshot = () => ["events", "resets", "mutations", "observations", "idempotency"].map((name) =>
      f.db.prepare(`SELECT * FROM character_affect_${name}_v6 ORDER BY rowid`).all());
    const before = snapshot();
    for (const sessionId of ["main", "aux"]) {
      // Broad grants cannot make unconnected management mutations available.
      const binding = f.project(f.started(sessionId, "claude", "affect", undefined, getMemoryV6AgentRuntimeOperations()));
      const { client, transport } = await f.connect(binding, "memoryUrl");
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === "character_affect.inspect"));
      const mcp = await client.callTool({ name: "character_affect.inspect", arguments: {} });
      const child = await cli(f, binding, "affect-inspect", {});
      assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
      assert.equal(child.code, 0, JSON.stringify(child.value));
      assert.deepEqual(mcp.structuredContent, child.value);
      assert.deepEqual(child.value.events.map((event: { targetId: string }) => event.targetId).sort(),
        [`${sessionId}-event`, "shared-relationship"].sort());
      for (const input of [{ characterId: "private-character" }, { sessionId: "other" }]) {
        assert.equal((await client.callTool({ name: "character_affect.inspect", arguments: input })).isError, true);
        assert.notEqual((await cli(f, binding, "affect-inspect", input)).code, 0);
      }
      for (const operation of ["correct", "reset"]) {
        assert.equal((await f.request(binding, binding.managedMcp!.memoryUrl, `character_affect.${operation}`, transport.sessionId, {})).status, 403);
        assert.notEqual((await cli(f, binding, `affect-${operation}`, {})).code, 0);
      }
    }
    for (const purpose of ["character-memory", "target-memory"] as const) {
      const binding = f.project(f.started("main", "claude", purpose, undefined, getMemoryV6AgentRuntimeOperations()));
      const { client } = await f.connect(binding, "memoryUrl");
      assert.equal((await client.listTools()).tools.some((tool) => tool.name === "character_affect.inspect"), true);
      assert.equal((await client.callTool({ name: "character_affect.inspect", arguments: {} })).isError, undefined);
      assert.equal((await cli(f, binding, "affect-inspect", {})).code, 0);
    }
    assert.deepEqual(snapshot(), before);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "背景inspectはsource incarnation/owner/親identityの不一致を拒否し、完了後は遅延応答も配布CLIも履歴を返さない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#背景memory-read" }
// fault = "inspectがcapture済みsourceを検証せず現在行を読む、返却前の失効確認を迂回して遅延履歴を公開する"
// observable = "不一致sourceのMCP/CLI拒否、読取完了後に実行を終了したHTTP応答と旧CLIの拒否"
// observation_boundary = "public-boundary"
// scope = "背景bindingからAffect Workerのsource検証とHTTP返却境界"
// lifecycle = "permanent"
// impact = "置換後または権限終了後の会話履歴が背景実行へ渡る"
// distinction = "既存Memory read寿命testはinspectのCharacter dispatchとAffect source検証を通らない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("背景Affect inspectはsource identityと返却前失効を検証する", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const scope = f.scope("aux", "affect");
    assert.equal(scope.history.source.kind, "auxiliary");
    if (scope.history.source.kind !== "auxiliary") throw new Error("Expected Auxiliary fixture");
    const source = scope.history.source;
    for (const invalid of [{ ...source, incarnationId: "replaced" }, { ...source, ownerIdentity: "replaced" },
      { ...source, parent: { ...source.parent, incarnationId: "replaced" } }]) {
      const execution = f.executions.begin({ actorSessionId: "aux", providerId: "claude",
        session: { ...f.sessions.get("aux")!, incarnationId: invalid.incarnationId },
        scope: { ...scope, history: { ...scope.history, source: invalid } },
        authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
        operationGrants: Object.values(backgroundMemoryToolOperations("affect", false)) });
      const binding = f.project(execution), { client } = await f.connect(binding, "memoryUrl");
      const mcp = await client.callTool({ name: "character_affect.inspect", arguments: {} });
      const child = await cli(f, binding, "affect-inspect", {});
      assert.equal(mcp.isError, true, JSON.stringify(mcp));
      assert.notEqual(child.code, 0);
      assert.equal("events" in child.value, false);
    }
    const execution = f.started("main", "claude", "affect", undefined, Object.values(backgroundMemoryToolOperations("affect", false)));
    const binding = f.project(execution);
    let entered!: () => void;
    const reading = new Promise<void>((done) => { entered = done; });
    const gate = new Promise<void>((done) => { release = done; });
    const inspect = f.characterContext.inspectAffect.bind(f.characterContext);
    f.characterContext.inspectAffect = async (...args) => { const result = await inspect(...args); entered(); await gate; return result; };
    const pending = direct(f, binding, "character_affect/inspect", { schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION });
    await reading;
    f.executions.finish(execution);
    release();
    const result = (await pending).value as Record<string, unknown>;
    assert.ok(result.error, JSON.stringify(result));
    assert.equal("events" in result, false);
    assert.notEqual((await cli(f, binding, "affect-inspect", {})).code, 0);
  } finally { release?.(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "未登録の許可ProjectはID/pathで空として読め、要求しない別targetの解決可否は読取に影響せず、読取はDB scopeを作らない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#背景memory-read" }
// fault = "未登録Projectを権限不正にする、capture済み全対象の存在確認でCharacter読取も拒否する、任意の許可IDを実Workspaceと照合せず救済する"
// observable = "MCP/CLIの保存済みCharacter本文、空Project検索・一覧・tag、Project+Character検索、要求拒否、DB scope件数"
// observation_boundary = "public-boundary"
// scope = "背景の実bindingからMCP/配布CLI、HTTP target解決、Memory Workerまで"
// lifecycle = "permanent"
// impact = "Memory初回利用が停止するか、要求対象の権限境界が曖昧になる"
// distinction = "登録済みProjectをseedする既存read testでは、DB未登録と許可集合を分ける必要性を検証できない"
// risk_tags = ["authorization"]
// @end-test-value
test("未登録Projectを含む背景scopeでも要求targetだけを判定してMCP/CLIで読む", async () => {
  const f = await fixture();
  try {
    const project = await unregisteredProject(f);
    const target = { owner: "project", scope: "project", project: { type: "id", id: project.id } } as const;
    const characterProject = { owner: "character", scope: "project", character: { type: "id", id: "character" }, project: target.project } as const;
    const unrelated = { owner: "project", scope: "project", project: { type: "id", id: "unavailable-project" } } as const;
    const saved = await f.memory.append(createLocalUserMemoryPrincipal(), { schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: characterTarget, kind: "note", title: "character probe", body: "saved character body", preview: "probe", tags: [] });
    assert.ok(!("error" in saved), JSON.stringify(saved));
    const binding = f.project(f.started("main", "claude", "target-memory", undefined, getBackgroundMemoryReadOperations(), {
      memoryTargets: [characterTarget, target, characterProject, unrelated], allowedProjectIds: [project.id, "unavailable-project"],
    }));
    const { client } = await f.connect(binding, "memoryUrl");
    const characterInput = { target: { kind: "character" }, includeBody: true };
    const characterMcp = await client.callTool({ name: "memory.list_entries", arguments: characterInput });
    const characterCli = await cli(f, binding, "list-entries", characterInput);
    assert.equal(characterMcp.isError, undefined, JSON.stringify(characterMcp));
    assert.equal(characterCli.code, 0);
    assert.deepEqual(characterMcp.structuredContent, characterCli.value);
    assert.equal(characterCli.value.items[0].body, "saved character body");
    for (const ref of [{ type: "id", id: project.id }, { type: "path", path: f.directory }]) {
      for (const kind of ["project", "character+project"]) {
        const publicTarget = { kind, project: ref };
        for (const op of [
          { tool: "memory.search", command: "search", input: { targets: [publicTarget], query: "probe" }, result: "items" },
          { tool: "memory.list_entries", command: "list-entries", input: { target: publicTarget }, result: "items" },
          { tool: "memory.list_tags", command: "list-tags", input: { targets: [publicTarget] }, result: "tags" },
        ]) {
          const mcp = await client.callTool({ name: op.tool, arguments: op.input });
          const child = await cli(f, binding, op.command, op.input);
          assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
          assert.equal(child.code, 0, JSON.stringify(child.value));
          assert.deepEqual(mcp.structuredContent, child.value);
          assert.deepEqual(child.value[op.result], []);
        }
      }
      const input = { scope: { scope: "project", project: ref }, query: "probe" };
      const mcp = await client.callTool({ name: "character_memory.search", arguments: input });
      const child = await cli(f, binding, "character-memory-search", input);
      assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
      assert.equal(child.code, 0, JSON.stringify(child.value));
      assert.deepEqual(mcp.structuredContent, child.value);
      assert.deepEqual(child.value.items, []);
    }
    // An allowed ID without a matching trusted Workspace is not a new Project candidate.
    const invalid = { targets: [{ kind: "project", project: { type: "id", id: "unavailable-project" } }], query: "probe" };
    assert.equal((await client.callTool({ name: "memory.search", arguments: invalid })).isError, true);
    assert.notEqual((await cli(f, binding, "search", invalid)).code, 0);
    const mixed = { targets: [{ kind: "character" }, { kind: "project", project: { type: "id", id: "outside" } }], query: "probe" };
    const rejected = await client.callTool({ name: "memory.search", arguments: mixed });
    assert.equal(rejected.isError, true);
    assert.equal("items" in (rejected.structuredContent as Record<string, unknown>), false);
    assert.notEqual((await cli(f, binding, "search", mixed)).code, 0);
    assert.equal(scopeCount(f), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "通常/背景の許可ProjectとCharacter+ProjectをID/pathで初回保存でき、失敗ではscopeを作らず成功保存とretryで一つのscope/entryを保持する"
// oracle = { type = "contract", ref = "docs/design/v6-memory-foundation.md#storage" }
// fault = "初回の許可Project IDを解決できない、背景入口がpath candidateを拒否する、失敗でscopeを作る、retryで保存を重複する"
// observable = "MCP/配布CLIの初回保存・read-back・replay、Worker entryのowner/scope、Project行とentryの件数"
// observation_boundary = "public-boundary"
// scope = "通常/背景bindingと実用途登録handlerからHTTP/Memory Workerの保存transaction"
// lifecycle = "permanent"
// impact = "新しいrepositoryのMemoryを登録できないか、失敗・retryで保存状態を壊す"
// distinction = "既存のpath service testはactor-relative ID解決や背景のwriteTargetsを通らず、背景登録testはuser/Character targetだけを使う"
// risk_tags = ["authorization"]
// @end-test-value
test("通常と背景の未登録Project初回保存はMCP/CLIで同じadmissionと保存結果を使う", async () => {
  for (const scenario of [
    { background: true, refType: "id", kind: "project", firstCli: false },
    { background: true, refType: "path", kind: "character+project", firstCli: true },
    { background: false, refType: "id", kind: "character+project", firstCli: true },
    { background: false, refType: "path", kind: "project", firstCli: false },
  ] as const) {
    const f = await fixture(undefined, backgroundMemoryRegistrationHandlers);
    let ordinaryTurn: ReturnType<typeof f.turns.begin> | undefined;
    try {
      const project = await unregisteredProject(f);
      const target = { owner: "project", scope: "project", project: { type: "id", id: project.id } } as const;
      const characterProject = { owner: "character", scope: "project", character: { type: "id", id: "character" }, project: target.project } as const;
      f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
        VALUES (1,'main','completed',1,?,?,?)`).run("2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
      let binding: Binding;
      if (scenario.background) {
        binding = f.project(f.started("main", "claude", "target-memory", undefined,
          [...getBackgroundMemoryReadOperations(), BACKGROUND_REGISTRATION_OPERATIONS["target-memory"].operation], {
            memoryTargets: [target, characterProject], allowedProjectIds: [project.id],
          }));
      } else {
        const issued = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", authoritySnapshot: {
          userId: "local-user", characterId: "character", allowedProjectIds: [project.id],
        }, operationGrants: getMemoryV6AgentRuntimeOperations() });
        ordinaryTurn = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
        const projected = { ...issued, turnCapability: ordinaryTurn.capability, memoryRuntimeOwner: owner };
        binding = { ...projected, managedMcp: f.host.issue(projected, ordinaryTurn, new AbortController().signal) };
      }
      const { client } = await f.connect(binding, "memoryUrl");
      const publicTarget = { kind: scenario.kind, project: scenario.refType === "id"
        ? { type: "id", id: project.id } : { type: "path", path: f.directory } };
      const input = { target: publicTarget, kind: "note", title: "first project memory", body: "saved project body",
        preview: "project probe", tags: [], idempotencyKey: "first-project" };
      const invalid = { ...input, supersedes: ["missing-entry"], idempotencyKey: "failed-first-project" };
      assert.equal((await client.callTool({ name: "memory.append", arguments: invalid })).isError, true);
      assert.equal(scopeCount(f), 0);
      const first = scenario.firstCli ? await cli(f, binding, "append", input)
        : { code: 0, value: (await client.callTool({ name: "memory.append", arguments: input })).structuredContent as Record<string, any> };
      assert.equal(first.code, 0, JSON.stringify(first.value));
      assert.ok(first.value.entry, JSON.stringify(first.value));
      assert.equal(scopeCount(f), 1);
      const stored = (await f.memoryWorker.storage.getEntry(first.value.entry.id))!;
      assert.equal(stored.scope.id, project.id);
      assert.equal(stored.owner.type, scenario.kind === "project" ? "project" : "character");
      assert.equal(stored.owner.id, scenario.kind === "project" ? project.id : "character");
      const read = { target: { kind: scenario.kind, project: { type: "id", id: project.id } }, entryId: stored.id };
      const mcpRead = await client.callTool({ name: "memory.get_entry", arguments: read });
      const cliRead = await cli(f, binding, "get-entry", read);
      assert.equal(mcpRead.isError, undefined, JSON.stringify(mcpRead));
      assert.equal(cliRead.code, 0);
      assert.deepEqual(mcpRead.structuredContent, cliRead.value);
      assert.equal(cliRead.value.entry.body, "saved project body");
      const replay = scenario.firstCli
        ? (await client.callTool({ name: "memory.append", arguments: input })).structuredContent as Record<string, any>
        : (await cli(f, binding, "append", input)).value;
      assert.equal(replay.replayed, true, JSON.stringify(replay));
      assert.equal(replay.entry.id, stored.id);
      assert.equal(scopeCount(f), 1);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6").get()!.count, 1);
    } finally {
      if (ordinaryTurn) f.turns.end(ordinaryTurn);
      await f.close();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "元会話と異なる背景Providerの通常認可readはmanaged MCPと配布CLIから実Memory Workerの同じ保存内容を返す"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "別Provider背景readを拒否する、入口間で異なるtargetや本文を返す、forgotten本文を通常readへ戻す"
// observable = "MCP公開tool名、MCPとCLIのJSON一致、seed済みentry ID・本文・tag、検索のforgotten除外"
// observation_boundary = "public-boundary"
// scope = "managed HTTP MCP and bundled child-process CLI through application authorization to MemoryV6WorkerClient.storage"
// lifecycle = "permanent"
// impact = "許可された生成材料を取得できないか、忘却済み本文を背景Providerへ公開する"
// distinction = "通常Memory単体testやhistory固定範囲testでは背景bindingから両公開入口と実Workerの接続を検証できない。推論なしの固定fixtureで読取操作をまとめる"
// @end-test-value
test("別Provider背景のMemory readが実MCPと配布CLIで一致する", async () => {
  const f = await fixture();
  try {
    const ids = await seed(f);
    const binding = f.project(start(f));
    const { client } = await f.connect(binding, "memoryUrl");
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      "character_memory.search", "memory.get_entry", "memory.list_entries", "memory.list_tags", "memory.search",
      "character_affect.inspect", "character_context.get", "character_context.metrics", "memory.audit", "memory.characters",
      "memory.file_usage", "memory.instances", "memory.list_targets", "memory.status",
    ].sort());
    const operations = [
      { tool: "memory.search", command: "search", input: { targets: [publicProject], query: "needle" } },
      { tool: "memory.list_entries", command: "list-entries", input: { target: publicProject, includeBody: true } },
      { tool: "memory.get_entry", command: "get-entry", input: { target: publicProject, entryId: ids.project } },
      { tool: "memory.list_tags", command: "list-tags", input: { targets: [publicProject] } },
      { tool: "character_memory.search", command: "character-memory-search", input: { scope: { scope: "character" }, query: "needle" } },
    ];
    for (const op of operations) {
      const mcp = await client.callTool({ name: op.tool, arguments: op.input });
      const child = await cli(f, binding, op.command, op.input);
      assert.equal(child.code, 0, JSON.stringify(child.value));
      assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
      assert.deepEqual(mcp.structuredContent, child.value, op.tool);
      if (op.tool === "memory.list_tags") assert.deepEqual(child.value.tags, [{ type: "topic", value: "background" }]);
      else if (op.tool === "memory.get_entry") assert.equal(child.value.entry.body, "saved project needle body");
      else {
        assert.deepEqual(child.value.items.map((item: { id: string }) => item.id), [op.tool === "character_memory.search" ? ids.character : ids.project]);
        if (op.tool === "memory.list_entries") assert.equal(child.value.items[0].body, "saved project needle body");
      }
      assert.doesNotMatch(JSON.stringify(child.value), /forgotten secret|private outside|private global|private character/);
    }
    assert.equal(f.sessions.get("main")!.provider, "codex");
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "背景三用途は通常scopeのMemory・診断・元Main Graph・許可checkout Glossaryを異ProviderのMCP/CLIから読み、Graph/Glossary変更とsource置換後の読取を拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "捕捉write targetへreadまで狭める、通常Provider一致を背景readへ適用する、同名MainとAuxiliaryのGraph ownerを混同する、Graph/Glossary mutationを公開する、失効sourceからデータを返す"
// observable = "MCPと配布CLIの保存済み本文・Graph topic・Glossary定義・診断成功、公開tool集合、変更拒否とsource置換後のerror"
// observation_boundary = "public-boundary"
// scope = "Mainと同名Mainを持つAuxiliaryの背景managed MCP/配布CLIからMemory Worker、Session Graph runtime、Glossary filesystem applicationまで"
// lifecycle = "permanent"
// impact = "管理役が必要な現在情報を読めないか、別用途の管理データを無断変更し、再作成済み会話へ旧権限を持ち越す"
// distinction = "各serviceの通常binding testでは異Provider背景turnとwrite捕捉targetに独立したread scopeを確認できない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("背景三用途の通常readとGraph・Glossary readをMCPと配布CLIで提供する", async () => {
  const f = await fixture(undefined, undefined, () => new Date("2026-11-01T01:00:00.000Z"));
  try {
    await seed(f);
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", f.directory], { windowsHide: true });
    const glossary = new GlossaryApplicationService();
    const checkout = await glossary.resolvePrimaryCheckout(f.directory);
    await glossary.create(checkout, { mode: "explicit", entry: { term: "Background", definition: "Shared glossary definition" } });
    await f.worker.stores.sessionGraph.execute({ sessionId: "main", incarnationId: "inc-main" }, "apply", {
      expectedRevision: 0, topics: [{ id: "management", title: "Shared graph topic" }],
    }, { sessionId: "main", sessionTitle: "Main", role: "main", character: { id: "character", name: "Character" } });
    for (const purpose of ["target-memory", "character-memory", "affect"] as const) {
      const binding = f.project(f.started("main", "claude", purpose, undefined,
        [...getBackgroundMemoryReadOperations(), ...getBackgroundReadOperations()], {
          memoryTargets: [], allowedProjectIds: ["project-a"], authoritySnapshot: {
            glossaryPrimaryCheckout: projectGlossaryCheckoutAuthority(checkout), sessionGraphOwner: { sessionId: "main", incarnationId: "inc-main" },
          },
        }));
      const { client } = await f.connect(binding, "memoryUrl");
      for (const op of [
        { tool: "memory.search", command: "search", input: { targets: [{ kind: "user-global" }], query: "needle" } },
        { tool: "memory.list_targets", command: "list-targets", input: {} },
        { tool: "memory.audit", command: "audit", input: { allTargets: true } },
        { tool: "memory.characters", command: "characters", input: {} },
        { tool: "memory.file_usage", command: "file-usage", input: {} },
        { tool: "memory.status", command: "status", input: {} },
        { tool: "memory.instances", command: "instances", input: {} },
        { tool: "character_context.metrics", command: "character-metrics", input: {} },
        { tool: "character_context.get", command: "context-get", input: { memoryLimit: 0 } },
      ]) {
        const mcp = await client.callTool({ name: op.tool, arguments: op.input });
        const child = await cli(f, binding, op.command, op.input);
        assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
        assert.equal(child.code, 0, JSON.stringify(child.value));
        if (op.command === "search") {
          assert.deepEqual(mcp.structuredContent, child.value);
          assert.equal(child.value.items[0].title, "private global needle");
        }
      }
      const graph = await f.connect(binding, "sessionGraphUrl"), terms = await f.connect(binding, "glossaryUrl");
      assert.deepEqual((await graph.client.listTools()).tools.map((tool) => tool.name).sort(), [
        "session_graph.context", "session_graph.get", "session_graph.list_topics", "session_graph.recent", "session_graph.search",
      ]);
      assert.deepEqual((await terms.client.listTools()).tools.map((tool) => tool.name).sort(), [
        "glossary.get", "glossary.list", "glossary.list_targets", "glossary.search", "glossary.validate",
      ]);
      const graphMcp = await graph.client.callTool({ name: "session_graph.list_topics", arguments: {} });
      const graphChild = await cli(f, binding, "list-topics", {}, {}, graphCli);
      assert.equal(graphMcp.isError, undefined, JSON.stringify(graphMcp));
      assert.equal(graphChild.code, 0, JSON.stringify(graphChild.value));
      assert.deepEqual(graphMcp.structuredContent, graphChild.value);
      assert.equal(graphChild.value.items[0].title, "Shared graph topic");
      const termMcp = await terms.client.callTool({ name: "glossary.get", arguments: { termOrAlias: "Background" } });
      const termChild = await cli(f, binding, "get", { termOrAlias: "Background" }, {}, glossaryCli);
      assert.equal(termMcp.isError, undefined, JSON.stringify(termMcp));
      assert.equal(termChild.code, 0, JSON.stringify(termChild.value));
      assert.deepEqual(termMcp.structuredContent, termChild.value);
      assert.match(JSON.stringify(termChild.value), /Shared glossary definition/);
      for (const [route, input] of [["session-graph/apply", { expectedRevision: 1 }],
        ["glossary/create", { mode: "explicit", entry: { term: "Denied", definition: "Denied" } }]] as const) {
        assert.notEqual((await direct(f, binding, route, input)).status, 200);
      }
      f.db.prepare("UPDATE sessions_v6 SET incarnation_id = 'replacement' WHERE id = 'main'").run();
      assert.equal((await terms.client.callTool({ name: "glossary.get", arguments: { termOrAlias: "Background" } })).isError, true);
      assert.equal((await graph.client.callTool({ name: "session_graph.list_topics", arguments: {} })).isError, true);
      assert.notEqual((await cli(f, binding, "list-topics", {}, {}, graphCli)).code, 0);
      assert.notEqual((await cli(f, binding, "get", { termOrAlias: "Background" }, {}, glossaryCli)).code, 0);
      f.db.prepare("UPDATE sessions_v6 SET incarnation_id = 'inc-main' WHERE id = 'main'").run();
    }
    f.db.prepare(`INSERT INTO sessions_v6(id,incarnation_id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES ('aux','same-created-at','Unrelated Main','active','codex',1,'test','on-request','character','{}','now','now','now')`).run();
    const unrelatedOwner = { sessionId: "aux", incarnationId: "same-created-at" };
    await f.worker.stores.sessionGraph.execute(unrelatedOwner, "apply", { expectedRevision: 0,
      topics: [{ id: "unrelated", title: "Unrelated Main private graph" }] },
    { sessionId: "aux", sessionTitle: "Unrelated Main", role: "main", character: { id: "character", name: "Character" } });
    const auxiliaryBinding = f.project(f.started("aux", "claude", "affect", undefined, getBackgroundReadOperations(), {
      authoritySnapshot: { sessionGraphOwner: { sessionId: "main", incarnationId: "inc-main" } },
    }));
    const auxiliaryGraph = await f.connect(auxiliaryBinding, "sessionGraphUrl");
    const auxiliaryMcp = await auxiliaryGraph.client.callTool({ name: "session_graph.list_topics", arguments: {} });
    const auxiliaryChild = await cli(f, auxiliaryBinding, "list-topics", {}, {}, graphCli);
    assert.equal(auxiliaryMcp.isError, undefined, JSON.stringify(auxiliaryMcp));
    assert.equal(auxiliaryChild.code, 0, JSON.stringify(auxiliaryChild.value));
    assert.deepEqual(auxiliaryMcp.structuredContent, auxiliaryChild.value);
    assert.equal(auxiliaryChild.value.items[0].title, "Shared graph topic");
    assert.doesNotMatch(JSON.stringify(auxiliaryChild.value), /Unrelated Main/);
    const wrongOwnerBinding = f.project(f.started("aux", "claude", "affect", undefined, getBackgroundReadOperations(), {
      authoritySnapshot: { sessionGraphOwner: unrelatedOwner },
    }));
    const wrongOwnerGraph = await f.connect(wrongOwnerBinding, "sessionGraphUrl");
    assert.equal((await wrongOwnerGraph.client.callTool({ name: "session_graph.list_topics", arguments: {} })).isError, true);
    assert.notEqual((await cli(f, wrongOwnerBinding, "list-topics", {}, {}, graphCli)).code, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "背景readの通常認可target・実entry所属・identity・grant・handleは両公開入口とapplicationで強制される"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "許可Projectや現在Characterを越えて読む、IDだけで外部entryを返す、広いissued grantやcapability省略で用途writeの上限を突破する"
// observable = "MCP直接HTTP拒否、CLI非zeroとerror、runtime認可error、拒否後も許可readの保存本文"
// observation_boundary = "public-boundary"
// scope = "normal read authority and captured write targets across MCP, bundled CLI and direct authenticated runtime calls"
// lifecycle = "permanent"
// impact = "許可外Memory・Characterの漏えい、背景からの変更・file export・別機能の権限逸脱"
// distinction = "tool一覧は直接呼出の拒否を証明しない。既存の通常認可testでは異Providerの背景例外と通常Provider一致の同時維持を検証しない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("背景Memoryの範囲拡大・直接write・他identityとbindingを拒否する", async () => {
  const f = await fixture();
  try {
    const ids = await seed(f);
    const binding = f.project(start(f));
    const { client, transport } = await f.connect(binding, "memoryUrl");
    const outside = [
      { tool: "memory.search", command: "search", route: "search", input: { targets: [publicOtherProject], query: "needle" } },
      { tool: "memory.list_entries", command: "list-entries", route: "list_entries", input: { target: publicOtherProject } },
      { tool: "memory.list_tags", command: "list-tags", route: "list_tags", input: { targets: [publicOtherProject] } },
      { tool: "memory.get_entry", command: "get-entry", route: "get_entry", input: { target: publicProject, entryId: ids.outside } },
      { tool: "memory.get_entry", command: "get-entry", route: "get_entry", input: { target: { kind: "character" }, entryId: ids.otherCharacter } },
    ];
    for (const op of outside) {
      const mcp = await client.callTool({ name: op.tool, arguments: op.input });
      const child = await cli(f, binding, op.command, op.input);
      assert.equal(mcp.isError, true, op.tool);
      assert.notEqual(child.code, 0);
      assert.match(child.value.error.code, /^MEMORY_(FORBIDDEN|INVALID_FIELD)$/);
      assert.deepEqual(mcp.structuredContent, child.value);
      const raw = await direct(f, binding, op.route, op.input);
      assert.partialDeepStrictEqual(raw.value, { error: { code: child.value.error.code } });
    }
    const forbidden = [
      { tool: "memory.append", command: "append", route: "append", input: { target: publicProject, kind: "note", title: "denied", body: "denied", preview: "denied", tags: [], idempotencyKey: "denied" } },
      { tool: "memory.forget", command: "forget", route: "forget", input: { target: publicProject, entryIds: [ids.project], reason: "privacy", idempotencyKey: "denied" } },
      { tool: "memory.move_entry", command: "move-entry", route: "move_entry", input: { entryId: ids.project, from: publicProject, to: publicOtherProject, reason: "denied", idempotencyKey: "denied" } },
      { tool: "memory.get_file", command: "get-file", route: "get_file", input: { target: publicProject, objectId: "object", outputPath: join(f.directory, "denied.txt") } },
      { tool: "memory.export_files", command: "export-files", route: "export_files", input: { target: publicProject, entryId: ids.project, outputDirectoryPath: f.directory } },
    ];
    for (const op of forbidden) {
      assert.equal((await f.request(binding, binding.managedMcp!.memoryUrl, op.tool, transport.sessionId, op.input)).status, 403);
      const child = await cli(f, binding, op.command, op.input);
      assert.notEqual(child.code, 0, op.command);
      assert.equal(child.value.error.code, "MEMORY_FORBIDDEN", JSON.stringify(child.value));
      assert.partialDeepStrictEqual((await direct(f, binding, op.route, op.input)).value, { error: { code: "MEMORY_FORBIDDEN" } });
    }
    const forged = { targets: [publicProject], query: "needle", characterId: "other-character" };
    assert.equal((await client.callTool({ name: "memory.search", arguments: forged })).isError, true);
    assert.partialDeepStrictEqual((await direct(f, binding, "search", forged)).value, { error: { code: "MEMORY_INVALID_FIELD", field: "characterId" } });
    const forgedCli = await cli(f, binding, "search", forged);
    assert.notEqual(forgedCli.code, 0);
    assert.match(JSON.stringify(forgedCli.value), /INVALID_INPUT/);
    // A broad issuance must not turn a same-Provider background into an ordinary writable connection.
    // Real checkout/graph authority prevents a missing app context from being the reason for rejection.
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", f.directory], { windowsHide: true });
    const checkout = await new GlossaryApplicationService().resolvePrimaryCheckout(f.directory);
    const broad = f.project(f.started("main", "codex", "affect", undefined, [
      ...getMemoryV6AgentRuntimeOperations(), ...getGlossaryAgentRuntimeOperations(), ...getSessionGraphAgentRuntimeOperations(),
    ], { memoryTargets: [projectTarget, characterTarget], allowedProjectIds: ["project-a", "project-b"],
      authoritySnapshot: { glossaryPrimaryCheckout: projectGlossaryCheckoutAuthority(checkout),
        sessionGraphOwner: { sessionId: "main", incarnationId: "inc-main" } } }));
    for (const capability of [broad.turnCapability, ""]) {
      for (const op of forbidden) {
        assert.partialDeepStrictEqual((await direct(f, broad, op.route, op.input, broad.bindingReference, capability)).value,
          { error: { code: "MEMORY_FORBIDDEN" } });
        const child = await cli(f, broad, op.command, op.input, { WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: capability });
        assert.notEqual(child.code, 0);
        assert.equal(child.value.error.code, "MEMORY_FORBIDDEN");
      }
      for (const [artifact, command, route, errorCode] of [
        [glossaryCli, "create", "glossary/create", "GLOSSARY_SESSION_BINDING_FORBIDDEN"],
        [graphCli, "apply", "session-graph/apply", "SESSION_BINDING_FORBIDDEN"],
      ]) {
        const mutation = command === "create" ? { mode: "explicit", entry: { term: "Denied", definition: "Denied" } }
          : { expectedRevision: 0 };
        const raw = await direct(f, broad, route, mutation, broad.bindingReference, capability);
        assert.partialDeepStrictEqual(raw.value, { ok: false, code: errorCode });
        const child = await cli(f, broad, command, mutation, { WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: capability }, artifact);
        assert.notEqual(child.code, 0);
        assert.equal(child.value.code, errorCode);
      }
    }
    const other = f.project(start(f, "character-memory"));
    assert.equal((await fetch(binding.managedMcp!.memoryUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory.search", arguments: { targets: [publicProject], query: "needle" } } }) })).status, 401);
    const missingBinding = await cli(f, binding, "search", { targets: [publicProject], query: "needle" }, {
      WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "",
    });
    assert.notEqual(missingBinding.code, 0);
    assert.ok(missingBinding.value.error);
    for (const [reference, capability] of [["invalid-binding", binding.turnCapability], [other.bindingReference, binding.turnCapability],
      [binding.bindingReference, "invalid-handle"], [binding.bindingReference, ""]]) {
      const raw = await direct(f, binding, "search", { targets: [publicProject], query: "needle" }, reference, capability);
      assert.match(JSON.stringify(raw.value), /MEMORY_FORBIDDEN|MEMORY_UNAUTHORIZED|RUNTIME_TURN_INACTIVE/);
      const child = await cli(f, binding, "search", { targets: [publicProject], query: "needle" }, {
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: reference, WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: capability,
      });
      assert.notEqual(child.code, 0);
      assert.ok(child.value.error);
    }
    // The background exception must not relax ordinary binding Provider equality.
    const normal = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "claude", authoritySnapshot: {
      userId: "local-user", characterId: "character", allowedProjectIds: ["project-a"],
    }, operationGrants: getBackgroundMemoryReadOperations() });
    const turn = f.turns.begin({ actorSessionId: "main", providerId: "claude" });
    const projected = { ...normal, memoryRuntimeOwner: owner, turnCapability: turn.capability };
    assert.partialDeepStrictEqual((await direct(f, projected, "search", { targets: [publicProject], query: "needle" })).value,
      { error: { code: "MEMORY_FORBIDDEN" } });
    assert.equal((await cli(f, projected, "search", { targets: [publicProject], query: "needle" })).value.error.code, "MEMORY_FORBIDDEN");
    f.turns.end(turn);
    assert.partialDeepStrictEqual((await client.callTool({ name: "memory.get_entry", arguments: { target: publicProject, entryId: ids.project } })).structuredContent,
      { entry: { body: "saved project needle body" } });
  } finally { await f.close(); }
});
