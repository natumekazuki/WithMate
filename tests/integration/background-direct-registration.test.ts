import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { buildWithMateMemoryCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { getBackgroundMemoryReadOperations } from "../../src-shared/agent-runtime/background-memory-read.js";
import { getSessionHistoryAgentRuntimeOperations } from "../../src-shared/session-history/session-history-contract.js";
import { BACKGROUND_REGISTRATION_OPERATIONS } from "../../src-shared/agent-runtime/background-operations.js";
import type { BackgroundPurpose, BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { validateCharacterMemoryAppendEpisodeRequest } from "../../src-shared/character-context/character-context-validation.js";
import { registerBackgroundAffect } from "../../src-electron/character/background-affect-registration.js";
import { runBackgroundAffectCall } from "../../src-electron/character/background-affect-call.js";
import { BackgroundCallService } from "../../src-electron/providers/background-call-service.js";
import { AFFECT_COMPOSITION_INSTRUCTIONS } from "../../src-shared/character-affect/affect-composition.js";
import { AFFECT_SCHEMA_VERSION, type EffectiveAffectState } from "../../src-shared/character-affect/affect-contract.js";
import { validateMemoryAppendRequest } from "../../src-shared/memory/memory-validation.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../../src-shared/memory/memory-contract.js";
import { createMemoryErrorResponse } from "../../src-shared/memory/memory-response-contract.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION } from "../../src-shared/character-context/character-context-contract.js";
import type { BackgroundRegistration } from "../../src-electron/providers/background-registration.js";
import { getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory/memory-v6-http-server.js";
import { callWithMateMemoryRuntime } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { currentRuntimeTurnAdmissionState, RuntimeTurnInactiveError } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { backgroundHistoryFixture as fixture, owner } from "../helpers/background-history-fixture.js";

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

// Memory adapters are fixture-only. Affect uses the production registration handler.
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
  affect: registerBackgroundAffect,
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
    candidates: [{ sourceTurnId: 1, layer: "session", targetType: "bug",
      targetId: "fixture", family: "interest", value: { label: "interest", valence: 0.4, arousal: 0.3 }, intensity: 0.6,
      reason: "A reproduction was found.", evidence: "The saved source turn completed." }],
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
    schemaVersion: op.route.startsWith("character_") ? CHARACTER_CONTEXT_SCHEMA_VERSION : MEMORY_V6_SCHEMA_VERSION, ...op.input,
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
// scope = "production Affect handler and fixture Memory adapters through managed MCP, bundled CLI and existing applications with Worker storage"
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
// claim = "Auxiliary履歴readは有効なまま、用途handlerが未対応のsource kindのwriteをMCP一覧・直接call・配布CLI・HTTPで拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#用途限定の登録接続" }
// fault = "handlerの存在だけでAuxiliary登録を公開・dispatchするか、Auxiliary履歴readまで閉じる"
// observable = "MCP公開toolと拒否status、CLIのunsupported_source、履歴本文、用途handler呼出件数"
// observation_boundary = "public-boundary"
// scope = "Auxiliary background source kind support through managed MCP, CLI and HTTP"
// lifecycle = "permanent"
// impact = "Main専用保存handlerへAuxiliaryのownerを誤投入することを防ぐ"
// distinction = "source読取単体では各公開入口の用途別tool公開とdispatch認可の一致を確認できない"
// @end-test-value
test("未対応のAuxiliary用途登録は各入口で拒否し履歴readは維持する", async () => {
  let calls = 0;
  const handler = () => { calls += 1; return {}; };
  const f = await fixture(undefined, { affect: handler, "target-memory": handler, "character-memory": handler });
  try {
    for (const purpose of purposes) {
      const execution = f.started("aux", "claude", purpose, undefined, [
        ...getBackgroundMemoryReadOperations(), ...getSessionHistoryAgentRuntimeOperations(), BACKGROUND_REGISTRATION_OPERATIONS[purpose].operation,
      ], { memoryTargets: [target, characterTarget] });
      const binding = f.project(execution);
      const { client, transport } = await f.connect(binding, "memoryUrl");
      const op = operation(purpose, `aux-${purpose}`);
      assert.equal((await client.listTools()).tools.some((tool) => tool.name === op.tool), false);
      assert.equal((await f.request(binding, binding.managedMcp!.memoryUrl, op.tool, transport.sessionId, op.input)).status, 403);
      const child = await cli(f, binding, op);
      assert.notEqual(child.code, 0);
      assert.match(JSON.stringify(child.value), /unsupported_source/);
      assert.match(JSON.stringify((await direct(f, binding, op)).value), /unsupported_source/);
      const { client: history } = await f.connect(binding, "sessionHistoryUrl");
      const read = await history.callTool({ name: "session_history.get_message", arguments: { seq: 0 } });
      assert.equal(read.isError, undefined, JSON.stringify(read));
      assert.match(JSON.stringify(read.structuredContent), /auxiliary source/);
      f.executions.finish(execution);
    }
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryが同名IDで異Characterでも、kindを保持した共通認可は実AuxiliaryのMemory readと対応明示handler呼出をHTTP・MCP・CLIで許可し、Auxiliary削除後はMainへ代用しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#用途限定の登録接続" }
// fault = "actor resolverへsource kindを渡さず同名Mainを先に採用するかAuxiliaryの代わりに親metadataを渡す"
// observable = "3入口のMemory read応答、MCP登録tool公開と登録応答、handlerの実source ID・Character・ownerIdentity"
// observation_boundary = "public-boundary"
// scope = "same-ID different-Character Main/Auxiliary actor resolution and explicit auxiliary adapter contract, not Auxiliary domain persistence"
// lifecycle = "permanent"
// distinction = "Auxiliary保存用途の意味を変えず共通portの接続可能性を実Worker読取で確認する"
// @end-test-value
test("同名MainとAuxiliaryは異Characterでも共通Memory認可が実source kindを保持する", async () => {
  const sources: string[] = [];
  const f = await fixture(undefined, { "target-memory": (input) => {
    sources.push(input.source.ownerIdentity);
    assert.equal(input.source.session.id, "aux");
    assert.equal(input.source.session.characterId, "character");
    assert.equal(input.scope.history.source.kind, "auxiliary");
    return createMemoryErrorResponse({ code: "MEMORY_FORBIDDEN", message: "Fixture adapter inspected the Auxiliary source without saving.",
      retryable: false, conversationMayContinue: true, effect: "none" });
  } }, undefined, { "target-memory": ["auxiliary"] });
  try {
    const auxiliary = f.sessions.get("aux")!;
    f.db.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES ('main-character','Main','now','now')").run();
    const sameMain = await f.worker.stores.session.insertSession({ ...f.sessions.get("main")!, id: "aux",
      incarnationId: "same-id-main", characterId: "main-character", workspacePath: join(f.directory, "other-main") });
    f.sessions.set("aux", sameMain);
    const execution = f.executions.begin({ actorSessionId: auxiliary.id, providerId: "claude", session: auxiliary,
      scope: { ...f.scope("aux", "target-memory"), memoryTargets: [target] },
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
      operationGrants: [...getBackgroundMemoryReadOperations(), BACKGROUND_REGISTRATION_OPERATIONS["target-memory"].operation] });
    const binding = f.project(execution);
    const { client } = await f.connect(binding, "memoryUrl");
    assert.equal((await client.listTools()).tools.some((tool) => tool.name === "memory.append"), true);
    const read: Operation = { tool: "memory.list_entries", command: "list-entries", route: "list_entries",
      input: { target: { kind: "user-global" } } };
    const mcpRead = await client.callTool({ name: read.tool, arguments: read.input });
    assert.equal(mcpRead.isError, undefined, JSON.stringify(mcpRead));
    const cliRead = await cli(f, binding, read);
    assert.equal(cliRead.code, 0, JSON.stringify(cliRead));
    assert.deepEqual(mcpRead.structuredContent, cliRead.value);
    assert.equal(((await direct(f, binding, read)).value as Record<string, unknown>).error, undefined);
    const mcpWrite = await client.callTool({ name: "memory.append", arguments: operation("target-memory", "aux-mcp").input });
    assert.equal(mcpWrite.isError, true, JSON.stringify(mcpWrite));
    assert.match(JSON.stringify(mcpWrite.structuredContent), /Fixture adapter inspected/);
    assert.match(JSON.stringify((await direct(f, binding, operation("target-memory", "aux-http"))).value), /Fixture adapter inspected/);
    const child = await cli(f, binding, operation("target-memory", "aux-port"));
    assert.notEqual(child.code, 0, JSON.stringify(child));
    assert.match(JSON.stringify(child.value), /Fixture adapter inspected/);
    assert.deepEqual(sources, Array(3).fill(f.scope("aux", "target-memory").history.source.ownerIdentity));
    f.db.prepare("DELETE FROM auxiliary_sessions WHERE id = 'aux'").run();
    const afterDeletion = await cli(f, binding, read);
    assert.notEqual(afterDeletion.code, 0);
    assert.partialDeepStrictEqual(afterDeletion.value, { error: { code: "MEMORY_FORBIDDEN", effect: "none" } });
    assert.deepEqual(sources.length, 3);
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

// @test-value v2
// kind = "security"
// claim = "背景Affectは候補全体の値と実Main Turnの範囲・終端・時刻を検証し、偽造値や不正sourceで一件も保存しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect登録入力と会話owner" }
// fault = "public schemaを迂回した余剰fieldや別会話・範囲外・未完了Turnを受理する"
// observable = "MCPのisError、配布CLIの非zero、直接runtimeのerror、実DBのAffectとMemory件数"
// observation_boundary = "public-boundary"
// scope = "production Affect handler, real Main source Worker and MCP/CLI/runtime input boundaries"
// lifecycle = "permanent"
// impact = "背景モデルが保存ownerや時刻を偽造し、許可外会話の感情を保存する"
// distinction = "schemaだけでは実DBにあるTurnのowner・履歴境界・終端時刻を確認できず、公開入力だけではruntime迂回を検出できない"
// risk_tags = ["authorization"]
// @end-test-value
test("背景Affectの候補値と実sourceを保存前に検証する", async () => {
  const f = await fixture(undefined, handlers);
  try {
    seed(f);
    f.db.prepare("INSERT INTO session_messages_v6(session_id,seq,role,body,created_at) VALUES ('main',2,'assistant','{}','now')").run();
    for (const [id, sessionId, phase, seq, time] of [
      [2, "other", "completed", 0, completedAt], [3, "main", "running", 1, completedAt],
      [4, "main", "completed", 1, null], [5, "main", "completed", 1, "2026-11-01T01:00:00+00:00"],
      [6, "main", "completed", 2, completedAt],
    ] as const) {
      f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(id, sessionId, phase, seq, completedAt, time, completedAt);
    }
    const begun = f.executions.begin({ actorSessionId: "main", providerId: "claude", session: f.sessions.get("main")!,
      scope: f.scope(),
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
      operationGrants: [BACKGROUND_REGISTRATION_OPERATIONS.affect.operation] });
    const binding = f.project(begun);
    const { client } = await f.connect(binding, "memoryUrl");
    for (const sourceTurnId of [999, 2, 3, 4, 5, 6]) {
      const op = operation("affect", "invalid-source");
      op.input.candidates[0].sourceTurnId = sourceTurnId;
      const mcp = await client.callTool({ name: op.tool, arguments: op.input });
      assert.equal(mcp.isError, true, String(sourceTurnId));
      assert.partialDeepStrictEqual(mcp.structuredContent, { error: { code: "invalid_input", effect: "none" } });
      const child = await cli(f, binding, op);
      assert.notEqual(child.code, 0, String(sourceTurnId));
      assert.partialDeepStrictEqual(child.value, { error: { code: "invalid_input", effect: "none" } });
    }
    const original = operation("affect", "invalid-values");
    const candidate = original.input.candidates[0];
    const invalid = [
      { ...candidate, occurredAt: completedAt }, { ...candidate, idempotencyKey: "caller-key" },
      { ...candidate, characterId: "other-character" }, { ...candidate, authority: { kind: "operator" } },
      { ...candidate, value: { ...candidate.value, extra: true } }, { ...candidate, reason: " " },
      { ...candidate, layer: "bad" }, { ...candidate, targetType: "bad" }, { ...candidate, family: "bad" },
      { ...candidate, value: { label: "bad", valence: 2 } }, { ...candidate, intensity: -1 },
      { ...candidate, sourceTurnId: 1.5 }, { ...candidate, layer: "relationship", targetType: "bug" },
    ];
    for (const bad of invalid) {
      const op = { ...original, input: { candidates: [candidate, bad] } };
      assert.equal((await client.callTool({ name: op.tool, arguments: op.input })).isError, true);
      assert.ok(((await direct(f, binding, op)).value as Record<string, unknown>).error);
    }
    assert.notEqual((await cli(f, binding, { ...original, input: { candidates: [invalid[0]] } })).code, 0);
    assert.ok(((await direct(f, binding, { ...original, input: { candidates: [] } })).value as Record<string, unknown>).error);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get()!.count, 0);
    for (const phase of ["failed", "canceled"]) {
      f.db.prepare("UPDATE session_turns_v6 SET phase = ? WHERE id = 1").run(phase);
      const saved = await cli(f, binding, original);
      assert.equal(saved.code, 0, JSON.stringify(saved.value));
    }
    f.executions.finish(begun);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get()!.count, 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6").get()!.count, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "背景Affectは現在の履歴window内の過去terminal TurnをMCPとCLIから選んで登録でき、後続の未保存Turn拒否で先行保存を戻さない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect登録入力と会話owner" }
// fault = "最新Turnだけを登録可能に制限するか、後続の不正Turn拒否で確定済みeventを取り消す"
// observable = "MCPとCLIの保存応答、未保存Turnの拒否、終了後の実DB event件数と保存時刻"
// observation_boundary = "public-boundary"
// scope = "production Affect registration over Main history with multiple saved terminal Turns"
// lifecycle = "permanent"
// distinction = "schemaや型では実履歴を用いた過去Turnの選択とtool保存効果の維持を確認できない"
// @end-test-value
test("新しいTurnがあっても過去terminal Turnを選び保存できる", async () => {
  const f = await fixture(undefined, handlers);
  try {
    seed(f);
    const newerAt = "2026-11-02T01:00:00.000Z";
    f.db.prepare("INSERT INTO session_messages_v6(session_id,seq,role,body,created_at) VALUES ('main',2,'assistant','{}','now')").run();
    f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
      VALUES (20,'main','completed',2,?,?,?)`).run(newerAt, newerAt, newerAt);
    const initial = f.scope();
    const execution = f.executions.begin({ actorSessionId: "main", providerId: "claude", session: f.sessions.get("main")!,
      scope: { ...initial, history: { ...initial.history, throughMessageSeq: 2 } },
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
      operationGrants: [BACKGROUND_REGISTRATION_OPERATIONS.affect.operation] });
    const binding = f.project(execution);
    const { client } = await f.connect(binding, "memoryUrl");
    const op = operation("affect", "past-terminal");
    op.input.candidates[0].sourceTurnId = 1;
    const mcp = await client.callTool({ name: op.tool, arguments: op.input });
    assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
    const child = await cli(f, binding, op);
    assert.equal(child.code, 0, JSON.stringify(child));
    const unsaved = { ...op, input: { candidates: [{ ...op.input.candidates[0], sourceTurnId: 999 }] } };
    assert.equal((await client.callTool({ name: op.tool, arguments: unsaved.input })).isError, true);
    assert.notEqual((await cli(f, binding, unsaved)).code, 0);
    f.executions.finish(execution);
    assert.deepEqual(f.db.prepare("SELECT occurred_at FROM character_affect_events_v6 ORDER BY id").all().map((row) => row.occurred_at),
      [completedAt, completedAt]);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Affect用途入力は未設定時だけpresetを使い、編集本文・材料を同一runOnceのAgentへ渡し、既知の登録失敗は後続取消でも失敗として先行保存を保持する"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#登録指示のプリセットと本文編集" }
// fault = "編集本文へpresetを重ねる、別実行で保存する、既知の登録拒否を取消や正常終了へ潰すか確定済み保存を失う"
// observable = "Agentが受ける本文とscope・材料、runOnce結果、MCP/CLI保存・拒否応答、後続失敗／取消への到達、通常contextと実DB件数"
// observation_boundary = "public-boundary"
// scope = "purpose input through real BackgroundCallService, MCP/CLI handler and normal context read"
// lifecycle = "permanent"
// impact = "ユーザーの本文編集が無効になる、登録されていない変更を保存済みと扱う、または失敗で先行保存が消える"
// distinction = "入力builderの単体testでは同一実行のtool経路と通常contextへの反映を確認できない。モデルが文言に従うことは保証しない"
// @end-test-value
test("編集本文とpresetを同じAgentへ渡しtool登録の実態を保持する", async () => {
  const f = await fixture(undefined, handlers, () => new Date(completedAt));
  try {
    seed(f);
    const context = { actorSessionId: "main", session: f.sessions.get("main")!, scope: f.scope(),
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
      operationGrants: [BACKGROUND_REGISTRATION_OPERATIONS.affect.operation] };
    const currentAffect: EffectiveAffectState = { schemaVersion: AFFECT_SCHEMA_VERSION, characterId: "character",
      userId: "local-user", sessionId: "main", evaluatedAt: completedAt, layers: [], components: [] };
    const base = { context, selection: { providerId: "claude", modelId: "fixture" }, onAdmitted() {},
      characterDefinition: "definition material", currentAffect };
    for (const instructionBody of [undefined, "サブエージェントを使わない。必要な変化を登録する。", ""]) {
      let calls = 0;
      const service = new BackgroundCallService({ executions: f.executions, runAgent: async (agent) => {
        calls++;
        const body = agent.userInput.split("## 登録指示\n\n")[1]!.split("\n\n## 実行範囲")[0];
        assert.equal(body, instructionBody ?? AFFECT_COMPOSITION_INSTRUCTIONS);
        if (instructionBody !== undefined) assert.equal(agent.userInput.includes(AFFECT_COMPOSITION_INSTRUCTIONS), false);
        assert.ok(agent.userInput.includes(base.characterDefinition));
        assert.ok(agent.userInput.includes(JSON.stringify(currentAffect)));
        assert.ok(agent.userInput.includes(JSON.stringify(context.scope)));
        // The Agent may finish without any registration. No model obedience is assumed.
      } });
      assert.deepEqual(await runBackgroundAffectCall(service, { ...base, instructionBody }), { kind: "completed" });
      assert.equal(calls, 1);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get()!.count, 0);
    }
    for (const ending of ["failure", "cancel"] as const) {
      let rejectedExitCode: number | undefined;
      let canceledExitCode: number | undefined;
      let reachedEnding = false;
      const service = new BackgroundCallService({ executions: f.executions, runAgent: async (agent) => {
        const binding = { ...agent.binding, memoryRuntimeOwner: owner,
          managedMcp: f.host.issue({ ...agent.binding, memoryRuntimeOwner: owner }, agent.handle, agent.signal) };
        const { client } = await f.connect(binding, "memoryUrl");
        const op = operation("affect", ending);
        const saved = await client.callTool({ name: op.tool, arguments: op.input });
        await assertSaved(f, "affect", saved.structuredContent!, ending);
        const invalid = { ...op, input: { candidates: [{ ...op.input.candidates[0], sourceTurnId: 999 }] } };
        rejectedExitCode = (await cli(f, binding, invalid)).code;
        if (ending === "failure") {
          reachedEnding = true;
          throw new Error("Agent failed after confirmed registration");
        }
        f.executions.cancel(agent.binding.bindingId);
        reachedEnding = true;
        canceledExitCode = (await cli(f, binding, op)).code;
      } });
      const result = await runBackgroundAffectCall(service, base);
      assert.equal(reachedEnding, true);
      assert.ok(rejectedExitCode !== undefined); assert.notEqual(rejectedExitCode, 0);
      if (ending === "cancel") { assert.ok(canceledExitCode !== undefined); assert.notEqual(canceledExitCode, 0); }
      assert.deepEqual(result, { kind: "failed", code: "invalid_input" });
    }
    const normal = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex",
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] }, operationGrants: getMemoryV6AgentRuntimeOperations() });
    const turn = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    try {
      const result = await callWithMateMemoryRuntime(f.connection, { method: "POST", path: "/v1/character_context/get",
        body: { schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION, memoryLimit: 0 } },
        { bindingReference: normal.bindingReference, turnCapability: turn.capability, signal: AbortSignal.timeout(5_000) });
      const value = result.value as Record<string, any>;
      assert.equal(value.error, undefined, JSON.stringify(value));
      assert.equal(value.affect.mode, "active");
      assert.ok(value.affect.effective.some((component: Record<string, unknown>) => component.targetId === "fixture"));
    } finally { f.turns.end(turn); }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get()!.count, 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6").get()!.count, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "背景Affectの途中保存が失敗または応答喪失しても確認済みprefixを返し、後続を呼ばず確定済みeventを残す"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#背景実行内のmcpcli直接登録" }
// fault = "appraiseが部分失敗を全件成功または効果なしへ変換する、後続候補を保存する、または確定済みeventを巻き戻す"
// observable = "MCP/配布CLIのpartial errorとsaved prefix・failed index、Workerからのevent保存件数とtarget"
// observation_boundary = "public-boundary"
// scope = "production handler with failure or lost response at the existing Affect Worker boundary"
// lifecycle = "permanent"
// distinction = "入力拒否やAgent失敗のtestでは既存appraiseの複数候補途中失敗と応答不明を観測できない"
// @end-test-value
test("途中失敗と保存応答喪失でも先行Affectを保持し後続を呼ばない", async () => {
  for (const failure of ["before-write", "lost-response"] as const) {
    const f = await fixture(undefined, handlers);
    try {
      seed(f);
      const record = f.memoryWorker.affectStorage.recordEvent.bind(f.memoryWorker.affectStorage);
      let attempted = 0;
      f.memoryWorker.affectStorage.recordEvent = async (event, options) => {
        attempted++;
        if (attempted === 2 && failure === "before-write") throw new Error("storage unavailable before dispatch");
        const result = await record(event, options);
        if (attempted === 2) throw new Error("storage response lost after commit");
        return result;
      };
      const binding = f.project(start(f, "affect"));
      const { client } = await f.connect(binding, "memoryUrl");
      const op = operation("affect", "partial");
      const candidate = op.input.candidates[0];
      op.input.candidates = [candidate, { ...candidate, targetId: "uncertain" }, { ...candidate, targetId: "unattempted" }];
      const response = failure === "before-write"
        ? (await client.callTool({ name: op.tool, arguments: op.input })).structuredContent!
        : (await cli(f, binding, op)).value;
      assert.partialDeepStrictEqual(response, { error: { code: "partial_failure", effect: "partial",
        details: { failedCandidateIndex: 1 } } });
      const saved = (response as Record<string, any>).error.details.saved;
      assert.equal(saved.length, 1);
      assert.equal(saved[0].candidateIndex, 0);
      assert.equal(attempted, 2);
      assert.ok(f.db.prepare("SELECT id FROM character_affect_events_v6 WHERE id = ?").get(saved[0].eventId));
      assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get()!.count,
        failure === "before-write" ? 1 : 2);
      assert.deepEqual(f.db.prepare("SELECT target_id FROM character_affect_events_v6 ORDER BY target_id").all().map((row) => row.target_id),
        failure === "before-write" ? ["fixture"] : ["fixture", "uncertain"]);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6").get()!.count, 0);
    } finally { await f.close(); }
  }
});
