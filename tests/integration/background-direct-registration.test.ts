import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { buildWithMateMemoryCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { getBackgroundMemoryReadOperations } from "../../src-shared/agent-runtime/background-memory-read.js";
import { BACKGROUND_REGISTRATION_OPERATIONS } from "../../src-shared/agent-runtime/background-operations.js";
import type { BackgroundPurpose, BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { validateCharacterAffectAppraiseRequest, validateCharacterMemoryAppendEpisodeRequest } from "../../src-shared/character-context/character-context-validation.js";
import { validateMemoryAppendRequest } from "../../src-shared/memory/memory-validation.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../../src-shared/memory/memory-contract.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION } from "../../src-shared/character-context/character-context-contract.js";
import type { BackgroundRegistration } from "../../src-electron/providers/background-registration.js";
import { getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory/memory-v6-http-server.js";
import { callWithMateMemoryRuntime } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { currentRuntimeTurnAdmissionState, RuntimeTurnInactiveError } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { backgroundHistoryFixture as fixture } from "../helpers/background-history-fixture.js";

const execFileAsync = promisify(execFile);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Binding = ReturnType<Fixture["project"]>;
const completedAt = "2026-11-01T01:00:00.000Z";
const target = { owner: "user", scope: "global" } as const;
const characterTarget = { owner: "character", scope: "character", character: { type: "id", id: "character" } } as const;
const purposes = ["target-memory", "character-memory", "affect"] as const;
let directory: string;
let artifact: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "withmate-direct-registration-cli-"));
  artifact = await buildWithMateMemoryCli(directory);
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

// These adapters are fixture-only: production purpose validators are connected by #909/#910.
// Shared request validation and the real source turn are checked before existing applications run.
const handlers: BackgroundRegistration["handlers"] = {
  "target-memory": async (input, services) => {
    assert.equal(input.source.turns[0]?.phase, "completed");
    const request = validateMemoryAppendRequest(input.body);
    assert.ok(request.ok, JSON.stringify(request));
    return services.memory.append(input.principal, request.value);
  },
  "character-memory": async (input, services) => {
    assert.equal(input.source.turns[0]?.phase, "completed");
    assert.deepEqual((input.body as Record<string, unknown>).authority, { kind: "conversation" });
    const request = validateCharacterMemoryAppendEpisodeRequest(input.body);
    assert.equal(request.sessionId, input.source.session.id);
    assert.equal(request.characterId, input.source.session.characterId);
    return services.character!.appendEpisode(request, input.transport, input.principal);
  },
  affect: async (input, services) => {
    assert.deepEqual((input.body as Record<string, unknown>).authority, { kind: "conversation" });
    const request = validateCharacterAffectAppraiseRequest(input.body);
    assert.equal(request.sessionId, input.source.session.id);
    assert.equal(request.characterId, input.source.session.characterId);
    assert.equal(input.principal.writeTargets, undefined);
    assert.deepEqual(input.principal.permissions, []);
    for (const candidate of request.candidates) {
      assert.equal(candidate.occurredAt, input.source.turns[0]?.completedAt);
      assert.equal(candidate.memoryEpisode, undefined);
    }
    return services.character!.appraise(request, input.transport);
  },
};

function seed(f: Fixture) {
  f.db.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES ('other-character','Other','now','now')").run();
  f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
    VALUES (1,'main','completed',1,?,?,?)`).run(completedAt, completedAt, completedAt);
}
function start(f: Fixture, purpose: BackgroundPurpose, broad = false, provider = "claude",
  memoryTargets: BackgroundExecutionScope["memoryTargets"] = [target, characterTarget]) {
  return f.started("main", provider, purpose, undefined, broad ? getMemoryV6AgentRuntimeOperations() : [
    ...getBackgroundMemoryReadOperations(), BACKGROUND_REGISTRATION_OPERATIONS[purpose].operation,
  ], { memoryTargets });
}
type Operation = { tool: string; command: string; route: string; input: Record<string, any> };
function operation(purpose: BackgroundPurpose, key: string): Operation {
  if (purpose === "target-memory") return { tool: "memory.append", command: "append", route: "append", input: {
    target: { kind: "user-global" }, kind: "note", title: key, body: `body ${key}`, preview: key, tags: [], idempotencyKey: key,
  } };
  if (purpose === "character-memory") return { tool: "character_memory.append_episode", command: "character-memory-append-episode",
    route: "character_memory/append_episode", input: { idempotencyKey: key,
      episode: { title: key, body: `body ${key}`, preview: key, observedFact: "The saved source turn completed." } } };
  return { tool: "character_affect.appraise", command: "affect-appraise", route: "character_affect/appraise", input: {
    candidates: [{ schemaVersion: "withmate-affect-v1", layer: "session", targetType: "bug",
      targetId: "fixture", family: "interest", value: { label: "interest", valence: 0.4, arousal: 0.3 }, intensity: 0.6,
      reason: "A reproduction was found.", evidence: "The saved source turn completed.", occurredAt: completedAt, idempotencyKey: key }],
  } };
}
async function cli(f: Fixture, binding: Binding, op: ReturnType<typeof operation>, env: NodeJS.ProcessEnv = {}) {
  const result = await execFileAsync(process.execPath, [artifact, op.command, "--json", JSON.stringify(op.input)], {
    cwd: f.directory, env: { ...f.cliEnv(binding), ...env }, timeout: 15_000, windowsHide: true,
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string; stderr: string }) => {
    assert.equal(typeof error.code, "number", error.stderr);
    return { code: error.code, stdout: error.stdout };
  });
  return { code: result.code, value: JSON.parse(result.stdout) as Record<string, any> };
}
async function direct(f: Fixture, binding: Binding, op: ReturnType<typeof operation>, capability = binding.turnCapability) {
  return callWithMateMemoryRuntime(f.connection, { method: "POST", path: `/v1/${op.route}`, body: {
    schemaVersion: op.route === "append" ? MEMORY_V6_SCHEMA_VERSION : CHARACTER_CONTEXT_SCHEMA_VERSION, ...op.input,
  } }, { bindingReference: binding.bindingReference, turnCapability: capability, signal: AbortSignal.timeout(5_000) });
}
async function assertSaved(f: Fixture, purpose: BackgroundPurpose, value: Record<string, any>, key: string) {
  assert.equal(value.error, undefined, JSON.stringify(value));
  if (purpose === "affect") {
    assert.equal(value.saved.length, 1, JSON.stringify(value));
    const row = f.db.prepare("SELECT occurred_at, memory_entry_id FROM character_affect_events_v6 WHERE id = ?").get(value.saved[0].eventId);
    assert.partialDeepStrictEqual(row, { occurred_at: completedAt, memory_entry_id: null });
  } else {
    assert.equal((await f.memoryWorker.storage.getEntry(value.entry.id))!.body, `body ${key}`);
  }
}

// @test-value v2
// kind = "contract"
// claim = "接続済み用途adapterの背景登録は同一Providerと別Providerの実MCP・配布CLIから既存Workerへ保存する"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#背景実行内のmcpcli直接登録" }
// fault = "背景登録を通常turnへ迂回するか、公開入口から既存保存境界へ届かない"
// observable = "公開tool一覧、MCPとCLIの保存結果、Worker読取本文とSQLite Affect eventのsource時刻"
// observation_boundary = "public-boundary"
// scope = "fixture-only purpose adapters through real managed MCP, bundled CLI and Memory/Character applications with Worker storage"
// lifecycle = "permanent"
// distinction = "単体認可testでは別Providerの実HTTPと配布CLI childからWorker保存までの配線を検証できない。3用途を同一fixtureでまとめる"
// @end-test-value
test("用途adapterを接続した背景登録がMCPと配布CLIから実Workerへ届く", async () => {
  const f = await fixture(undefined, handlers);
  try {
    seed(f);
    for (const provider of ["codex", "claude"]) for (const purpose of purposes) {
      const execution = start(f, purpose, false, provider);
      const binding = f.project(execution);
      const { client } = await f.connect(binding, "memoryUrl");
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
        "character_memory.search", "memory.get_entry", "memory.list_entries", "memory.list_tags", "memory.search",
        BACKGROUND_REGISTRATION_OPERATIONS[purpose].tool,
      ].sort());
      const mcpOp = operation(purpose, `${provider}-${purpose}-mcp`);
      const mcp = await client.callTool({ name: mcpOp.tool, arguments: mcpOp.input });
      assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
      await assertSaved(f, purpose, mcp.structuredContent!, `${provider}-${purpose}-mcp`);
      const child = await cli(f, binding, operation(purpose, `${provider}-${purpose}-cli`));
      assert.equal(child.code, 0, JSON.stringify(child.value));
      await assertSaved(f, purpose, child.value, `${provider}-${purpose}-cli`);
      f.executions.finish(execution);
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "広いgrantでも各用途の登録上限・捕捉保存先・source identity・current handleをMCPとCLIで強制する"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#維持する境界" }
// fault = "用途外登録、読取先だけを根拠にしたwrite、偽造sourceやhandle、Affect linked episodeを許可する"
// observable = "MCP直接callの403、CLI非zero、runtimeとservice principalの拒否error、MemoryとAffectの保存件数"
// observation_boundary = "public-boundary"
// scope = "background purpose ceiling and registration authority over real MCP/CLI/runtime boundaries"
// lifecycle = "permanent"
// impact = "背景Agentが許可外のMemoryやAffectを変更する"
// distinction = "公開一覧だけでは直接callとbound CLIによる権限逸脱を検出できず、型検査もruntime source変更を検出しない"
// risk_tags = ["authorization"]
// @end-test-value
test("用途上限と保存先・source・handleの逸脱を拒否する", async () => {
  const f = await fixture(undefined, handlers);
  try {
    seed(f);
    for (const purpose of purposes) {
      const execution = start(f, purpose, true);
      const binding = f.project(execution);
      const { client, transport } = await f.connect(binding, "memoryUrl");
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const other of purposes.filter((value) => value !== purpose)) {
        const op = operation(other, "forbidden-purpose");
        assert.equal(names.includes(op.tool), false);
        assert.equal((await f.request(binding, binding.managedMcp!.memoryUrl, op.tool, transport.sessionId, op.input)).status, 403);
        assert.notEqual((await cli(f, binding, op)).code, 0);
      }
      const op = operation(purpose, "invalid-handle");
      for (const capability of ["", "wrong-handle"]) {
        assert.ok(((await direct(f, binding, op, capability)).value as Record<string, unknown>).error);
        assert.notEqual((await cli(f, binding, op, { WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: capability })).code, 0);
      }
      f.executions.finish(execution);
    }
    const execution = start(f, "target-memory", false, "claude", [characterTarget]);
    const binding = f.project(execution);
    const { client } = await f.connect(binding, "memoryUrl");
    const outside = operation("target-memory", "outside");
    assert.equal((await client.callTool({ name: outside.tool, arguments: outside.input })).isError, true);
    assert.notEqual((await cli(f, binding, outside)).code, 0);
    assert.notEqual((await cli(f, binding, outside, { WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "" })).code, 0);
    for (const [column, value] of [["incarnation_id", "recreated"], ["character_id", "other-character"]]) {
      f.db.prepare(`UPDATE sessions_v6 SET ${column} = ? WHERE id = 'main'`).run(value);
      const op = operation("target-memory", "wrong-source");
      op.input.target = { kind: "character" };
      const mcp = await client.callTool({ name: op.tool, arguments: op.input });
      assert.equal(mcp.isError, true);
      assert.match(JSON.stringify(mcp.structuredContent), /source_denied/);
      const child = await cli(f, binding, op);
      assert.notEqual(child.code, 0);
      assert.match(JSON.stringify(child.value), /source_denied/);
      f.db.prepare(`UPDATE sessions_v6 SET ${column} = ? WHERE id = 'main'`).run(column === "incarnation_id" ? "inc-main" : "character");
    }
    f.executions.finish(execution);
    const readOnly = f.project(f.started("main", "claude", "target-memory", undefined, getBackgroundMemoryReadOperations(), { memoryTargets: [target] }));
    assert.notEqual((await cli(f, readOnly, operation("target-memory", "read-is-not-write"))).code, 0);
    const readPrincipal = { type: "session_binding" as const, bindingIdHash: "fixture-read", sessionId: "main",
      providerId: "claude", characterId: "character", permissions: ["memory.append" as const],
      readTargets: [{ owner: { type: "user", id: "local-user" }, scope: { type: "global", id: "global" } }] as const };
    assert.partialDeepStrictEqual(await f.memory.append(readPrincipal, {
      ...operation("target-memory", "read-principal-only").input, schemaVersion: MEMORY_V6_SCHEMA_VERSION, target,
    }), { error: { code: "MEMORY_FORBIDDEN" } });
    const affect = f.project(start(f, "affect"));
    const { client: affectClient } = await f.connect(affect, "memoryUrl");
    const linked = operation("affect", "linked");
    linked.input = { ...linked.input, candidates: [{ ...linked.input.candidates![0], memoryEpisode: { title: "forbidden" } }] };
    assert.notEqual((await cli(f, affect, linked)).code, 0);
    assert.equal((await affectClient.callTool({ name: linked.tool, arguments: linked.input })).isError, true);
    assert.match(JSON.stringify((await direct(f, affect, linked)).value), /linked_episode_forbidden/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6").get()!.count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get()!.count, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "未接続の背景登録は公開せず拒否し、実行終了や取消後のwriteは拒否して確定済み保存を保持する"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#維持する境界" }
// fault = "用途adapter不在を通常登録で救済するか、終了後writeを通すか、後続失敗で先行保存を失う"
// observable = "非公開tool、MCP拒否、CLI非zeroとnot_connected、終了後のWorker entry本文"
// observation_boundary = "public-boundary"
// scope = "disconnected registration and background finish/cancel lifetime through real public entry points"
// lifecycle = "permanent"
// impact = "未検証の背景候補や失効後のwriteが保存される、または確定済みユーザーデータが消える"
// distinction = "実Workerへ先に保存して後続失敗を起こすため、callbackやtoken失効の単体testでは代替できない"
// @end-test-value
test("未接続を拒否し終了・取消後も先行保存だけを保持する", async () => {
  const disconnected = await fixture();
  try {
    seed(disconnected);
    for (const purpose of purposes) {
      const execution = start(disconnected, purpose);
      const binding = disconnected.project(execution);
      const { client, transport } = await disconnected.connect(binding, "memoryUrl");
      const op = operation(purpose, "not-connected");
      assert.equal((await client.listTools()).tools.some((tool) => tool.name === op.tool), false);
      assert.equal((await disconnected.request(binding, binding.managedMcp!.memoryUrl, op.tool, transport.sessionId, op.input)).status, 403);
      const child = await cli(disconnected, binding, op);
      assert.notEqual(child.code, 0);
      assert.partialDeepStrictEqual(child.value, { error: { effect: "none", details: { backgroundRegistration: "not_connected" } } });
      disconnected.executions.finish(execution);
    }
  } finally { await disconnected.close(); }
  const f = await fixture(undefined, handlers);
  try {
    seed(f);
    for (const end of ["finish", "cancel"] as const) {
      const execution = start(f, "target-memory");
      const binding = f.project(execution);
      const { client } = await f.connect(binding, "memoryUrl");
      const saved = await cli(f, binding, operation("target-memory", `saved-${end}`));
      assert.equal(saved.code, 0, JSON.stringify(saved.value));
      const invalid = { ...operation("target-memory", "bad"), input: { ...operation("target-memory", "bad").input, body: "" } };
      assert.equal((await client.callTool({ name: invalid.tool, arguments: invalid.input })).isError, true);
      if (end === "finish") f.executions.finish(execution);
      else f.executions.cancel(execution.binding.bindingId);
      const later = operation("target-memory", `after-${end}`);
      assert.equal((await f.request(binding, binding.managedMcp!.memoryUrl, later.tool, undefined, later.input)).status, 401);
      assert.notEqual((await cli(f, binding, later)).code, 0);
      assert.equal((await f.memoryWorker.storage.getEntry(saved.value.entry.id))!.body, `body saved-${end}`);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6").get()!.count, 2);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "受付済みの背景登録も取消後のapplication待ちから同じ失効admissionで再開し、未確定writeを保存しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#用途限定の登録接続" }
// fault = "HTTP認可のadmissionを用途handlerまたはawait後のWorker mutationへ伝播しない"
// observable = "handler内の共有state同一性、Memory appendの失効例外、CLI失敗、実DBの保存件数"
// observation_boundary = "public-boundary"
// scope = "accepted MCP/CLI registration interrupted before the existing Memory Worker mutation"
// lifecycle = "permanent"
// impact = "背景実行の取消後に遅延した登録がユーザーデータへ反映される"
// distinction = "新規requestの入口拒否では受付後のawaitを越えたadmission伝播を検証できない。同期barrierで両実入口を確認する"
// risk_tags = ["authorization"]
// @end-test-value
test("受付済み登録の取消をapplicationからWorkerへの保存境界で拒否する", { timeout: 30000 }, async () => {
  for (const transport of ["mcp", "cli"] as const) {
    const entered = deferred(), release = deferred(), settled = deferred();
    let blocked = false;
    const f = await fixture(undefined, { "target-memory": async (input, services) => {
      assert.equal(currentRuntimeTurnAdmissionState(), input.admission.state);
      entered.resolve(); await release.promise;
      try {
        await handlers["target-memory"]!(input, services);
      } catch (error) {
        blocked = error instanceof RuntimeTurnInactiveError;
        throw error;
      } finally { settled.resolve(); }
    } });
    try {
      seed(f);
      const execution = start(f, "target-memory"), binding = f.project(execution);
      const { client } = await f.connect(binding, "memoryUrl");
      const op = operation("target-memory", "canceled-pending");
      const pending = transport === "mcp"
        ? client.callTool({ name: op.tool, arguments: op.input }).then(() => undefined, () => undefined)
        : cli(f, binding, op).then((result) => { assert.notEqual(result.code, 0); });
      await entered.promise;
      f.executions.cancel(execution.binding.bindingId);
      release.resolve(); await settled.promise;
      if (transport === "mcp") await client.close();
      await pending;
      assert.equal(blocked, true);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6").get()!.count, 0);
    } finally { release.resolve(); await f.close(); }
  }
});
