import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { buildWithMateMemoryCli, buildWithMateGlossaryCli, buildWithMateSessionGraphCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { getBackgroundMemoryReadOperations } from "../../src-shared/agent-runtime/background-memory-read.js";
import { MEMORY_V6_SCHEMA_VERSION, type MemoryTargetSelector } from "../../src-shared/memory/memory-contract.js";
import { createLocalUserMemoryPrincipal } from "../../src-electron/memory/memory-v6-permission.js";
import { getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory/memory-v6-http-server.js";
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
const characterTarget: MemoryTargetSelector = { owner: "character", scope: "character", character: { type: "id", id: "character" } };
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
    memoryTargets: [projectTarget, characterTarget], allowedProjectIds: ["project-a", "project-b"],
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

// @test-value v2
// kind = "contract"
// claim = "元会話と異なる背景Providerの許可5 readはmanaged MCPと配布CLIから実Memory Workerの同じ保存内容を返す"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "別Provider背景readを拒否する、入口間で異なるtargetや本文を返す、forgotten本文を通常readへ戻す"
// observable = "MCP公開tool名、MCPとCLIのJSON一致、seed済みentry ID・本文・tag、検索のforgotten除外"
// observation_boundary = "public-boundary"
// scope = "managed HTTP MCP and bundled child-process CLI through application authorization to MemoryV6WorkerClient.storage"
// lifecycle = "permanent"
// impact = "許可された生成材料を取得できないか、忘却済み本文を背景Providerへ公開する"
// distinction = "通常Memory単体testやhistory固定範囲testでは背景bindingから両公開入口と実Workerの接続を検証できない。推論なしの固定fixtureで5操作をまとめる"
// @end-test-value
test("別Provider背景のMemory readが実MCPと配布CLIで一致する", async () => {
  const f = await fixture();
  try {
    const ids = await seed(f);
    const binding = f.project(start(f));
    const { client } = await f.connect(binding, "memoryUrl");
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      "character_memory.search", "memory.get_entry", "memory.list_entries", "memory.list_tags", "memory.search",
    ]);
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
// kind = "security"
// claim = "背景readのtarget集合・実entry所属・identity・grant・handleは両公開入口とapplicationで強制される"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "scopeをauthority全体やglobalへ拡張する、IDだけで外部entryを返す、広いissued grantやcapability省略で背景readの上限を突破する"
// observable = "MCP直接HTTP拒否、CLI非zeroとerror、runtime認可error、拒否後も許可readの保存本文"
// observation_boundary = "public-boundary"
// scope = "captured Memory targets and binding authorization across MCP, bundled CLI and direct authenticated runtime calls"
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
      { tool: "memory.search", command: "search", route: "search", input: { targets: [{ kind: "user-global" }], query: "needle" } },
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
      assert.equal(child.value.error.code, "MEMORY_FORBIDDEN");
      assert.deepEqual(mcp.structuredContent, child.value);
      const raw = await direct(f, binding, op.route, op.input);
      assert.partialDeepStrictEqual(raw.value, { error: { code: "MEMORY_FORBIDDEN" } });
    }
    const forbidden = [
      { tool: "memory.append", command: "append", route: "append", input: { target: publicProject, kind: "note", title: "denied", body: "denied", preview: "denied", tags: [], idempotencyKey: "denied" } },
      { tool: "memory.forget", command: "forget", route: "forget", input: { target: publicProject, entryIds: [ids.project], reason: "privacy", idempotencyKey: "denied" } },
      { tool: "memory.move_entry", command: "move-entry", route: "move_entry", input: { entryId: ids.project, from: publicProject, to: publicOtherProject, reason: "denied", idempotencyKey: "denied" } },
      { tool: "memory.get_file", command: "get-file", route: "get_file", input: { target: publicProject, objectId: "object", outputPath: join(f.directory, "denied.txt") } },
      { tool: "memory.export_files", command: "export-files", route: "export_files", input: { target: publicProject, entryId: ids.project, outputDirectoryPath: f.directory } },
      { tool: "memory.list_targets", command: "list-targets", route: "list_targets", input: {} },
    ];
    for (const op of forbidden) {
      assert.equal((await f.request(binding, binding.managedMcp!.memoryUrl, op.tool, transport.sessionId, op.input)).status, 403);
      const child = await cli(f, binding, op.command, op.input);
      assert.notEqual(child.code, 0, op.command);
      assert.equal(child.value.error.code, "MEMORY_FORBIDDEN", JSON.stringify(child.value));
      assert.partialDeepStrictEqual((await direct(f, binding, op.route, op.input)).value, { error: { code: "MEMORY_FORBIDDEN" } });
    }
    for (const [url, tool, artifact, command] of [
      [binding.managedMcp!.glossaryUrl, "glossary.list", glossaryCli, "list"],
      [binding.managedMcp!.sessionGraphUrl, "session_graph.list_topics", graphCli, "list-topics"],
    ]) {
      assert.equal((await f.request(binding, url, tool, undefined, {})).status, 403);
      const child = await cli(f, binding, command, {}, {}, artifact);
      assert.notEqual(child.code, 0);
      assert.match(JSON.stringify(child.value), /SESSION_BINDING_FORBIDDEN/);
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
        [glossaryCli, "list", "glossary/list", "GLOSSARY_SESSION_BINDING_FORBIDDEN"],
        [graphCli, "list-topics", "session-graph/list-topics", "SESSION_BINDING_FORBIDDEN"],
      ]) {
        const raw = await direct(f, broad, route, {}, broad.bindingReference, capability);
        assert.partialDeepStrictEqual(raw.value, { ok: false, code: errorCode });
        const child = await cli(f, broad, command, {}, { WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: capability }, artifact);
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
