import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { buildWithMateMemoryCli, buildWithMateGlossaryCli, buildWithMateSessionGraphCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { getBackgroundMemoryReadOperations } from "../../src-shared/agent-runtime/background-memory-read.js";
import { BACKGROUND_REGISTRATION_OPERATIONS } from "../../src-shared/agent-runtime/background-operations.js";
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
