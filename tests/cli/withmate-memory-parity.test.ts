import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { runWithMateMemoryCli } from "../../src-cli/memory/withmate-memory.js";
import { createWithMateMemoryMcpServer, withMateMemoryToolName } from "../../src-electron/platform/mcp/withmate-memory-mcp.js";
import type { WithMateMemoryRuntimeOperation } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";

const env = {
  WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777",
  WITHMATE_MEMORY_API_SECRET: "api-secret",
  WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
  WITHMATE_MEMORY_OPERATOR_API_SECRET: "cli-secret",
  WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "test-generation",
};

// @test-value v2
// kind = "contract"
// claim = "raw JSONのproject pathは両入口で元入力の絶対path条件と1000文字上限を検証し、local validateは元表記を保持、dispatch時だけ共通正規化する"
// oracle = { type = "contract", ref = "docs/runbooks/development-workflow.md#MCPとCLIの機能・操作契約" }
// fault = "CLIが公開schema前にpathを短縮して上限超過を受理するか、validate結果又は通常dispatchがMCPと異なる"
// observable = "SDK MCPとCLIのlocal validate結果、通常操作の受理・拒否、runtime request件数とproject path"
// observation_boundary = "public-boundary"
// scope = "memory-cli-mcp-raw-project-path"
// lifecycle = "permanent"
// distinction = "共通schema単体では観測できないCLI JSON parserの事前変換をSDK入口との比較で検出する"
// @end-test-value
it("raw JSONのproject path検証とdispatch正規化を両入口で揃える", async () => {
  const operations: WithMateMemoryRuntimeOperation[] = [];
  const runtimeCall = async (_connection: unknown, operation: WithMateMemoryRuntimeOperation) => {
    operations.push(operation);
    return { ok: true, status: 200, value: { schemaVersion: "withmate-memory-v1", items: [] } };
  };
  const server = createWithMateMemoryMcpServer({ env, runtimeCall });
  const client = new Client({ name: "path-parity-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const oversizedPath = "C:/" + "a/../".repeat(201) + "x";
  assert.equal(oversizedPath.length, 1009);
  const cases = [
    { path: oversizedPath, normalized: undefined },
    { path: ".", normalized: undefined },
    { path: "C:\\repo\\..\\x", normalized: "C:/x" },
    { path: "C:/repo", normalized: "C:/repo" },
  ];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const sample of cases) {
      const input = { targets: [{ kind: "project", project: { type: "path", path: sample.path } }], query: "review" };
      let output = "";
      const stdout = { write: (value: string | Uint8Array) => { output += value; return true; } };
      const local = await client.callTool({ name: "memory.validate", arguments: { command: "search", input } });
      const validationExit = await runWithMateMemoryCli(["validate", "--command", "search", "--json", JSON.stringify(input)], { env, runtimeCall, stdout });
      assert.deepEqual(JSON.parse(output), local.structuredContent);
      assert.equal(validationExit, sample.normalized === undefined ? 3 : 0);
      if (sample.normalized === undefined) {
        assert.equal((local.structuredContent as { error: { code: string } }).error.code, "WITHMATE_MEMORY_INVALID_INPUT");
      } else {
        assert.deepEqual((local.structuredContent as { value: unknown }).value, input);
      }
      assert.equal(operations.length, 0, "local validation must not dispatch");
      const result = await client.callTool({ name: "memory.search", arguments: input });
      output = "";
      const exit = await runWithMateMemoryCli(["search", "--json", JSON.stringify(input)], { env, runtimeCall, stdout });
      assert.equal(exit, sample.normalized === undefined ? 3 : 0);
      if (sample.normalized === undefined) {
        assert.equal(result.isError, true);
        assert.equal(operations.length, 0, "invalid raw paths must not dispatch");
      } else {
        assert.deepEqual(JSON.parse(output), result.structuredContent);
        assert.equal(operations.length, 2);
        const expected = { method: "POST", path: "/v1/search", body: { ...input, targets: [{ kind: "project", project: { type: "path", path: sample.normalized } }], schemaVersion: "withmate-memory-v1" } };
        assert.deepEqual(operations[0], expected);
        assert.deepEqual(operations[1], expected);
      }
      operations.length = 0;
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "CLIとMCPは同じ公開入力から同じruntime operationを送り、拒否結果のschema/code/effectを同じ値で返す"
// oracle = { type = "contract", ref = "docs/runbooks/memory-affect-mcp.md CLI/MCP公開操作" }
// fault = "一方だけが別route、default、caller identity又は異なるdomain error mappingを使う"
// observable = "両transportのruntime requestと利用者が受け取るstructured result"
// observation_boundary = "public-boundary"
// scope = "memory-cli-mcp-parity"
// lifecycle = "permanent"
// distinction = "schema静的検査では分からないCLI argument parserとMCP registrationからdispatch/errorまでの合成を比較する"
// @end-test-value
it("公開Memory操作のdispatchとdomain拒否をCLIとMCPで同じにする", async () => {
  const episode = { title: "shared event", body: "event body", preview: "event", observedFact: "observed" };
  const affect = { schemaVersion: "withmate-affect-v1", layer: "session", targetType: "task", targetId: "task", family: "interest", value: { label: "interest", valence: 0.2, arousal: 0.4 }, intensity: 0.4, reason: "reason", evidence: "evidence", occurredAt: "2026-10-29T00:00:00Z", idempotencyKey: "event" };
  const target = { kind: "user-global" };
  const samples: Array<[string, unknown]> = [
    ["status", {}], ["status", { all: true }], ["instances", {}], ["characters", {}], ["file_usage", { largest: true, limit: 3 }],
    ["list_targets", { filter: target }], ["list_entries", { target }], ["audit", { targets: [target], staleBefore: "2026-10-01T00:00:00Z", cursor: "page" }],
    ["search", { targets: [target], query: "query" }], ["get_entry", { target, entryId: "entry" }],
    ["get_file", { target, objectId: "object", outputPath: "C:/exports/file" }], ["export_files", { target, entryId: "entry", outputDirectoryPath: "C:/exports" }],
    ["list_tags", { targets: [target] }], ["append", { target, kind: "note", title: "title", body: "body", preview: "preview", idempotencyKey: "append" }],
    ["forget", { target, entryIds: ["entry"], reason: "user_request", idempotencyKey: "forget" }],
    ["move_entry", { entryId: "entry", from: target, to: { kind: "project", project: { type: "id", id: "project" } }, reason: "move", idempotencyKey: "move" }],
    ["context_get", {}], ["affect_appraise", { candidates: [affect] }], ["affect_inspect", {}],
    ["affect_correct", { eventId: "event", expectedVersion: "version", explicitUserRequest: true, reason: "correction", replacement: affect }],
    ["affect_reset", { layer: "session", expectedVersion: "version", explicitUserRequest: true, reason: "reset", resetAt: "2026-10-29T00:00:00Z", idempotencyKey: "reset" }],
    ["character_memory_search", { query: "query", scope: { scope: "character" } }], ["character_memory_append_episode", { episode, idempotencyKey: "episode" }],
    ["character_memory_correct", { entryId: "entry", replacement: episode, reason: "correction", idempotencyKey: "correct" }],
    ["character_memory_forget", { entryId: "entry", reason: "user_request", idempotencyKey: "forget" }], ["character_metrics", {}],
  ];
  const operations: WithMateMemoryRuntimeOperation[] = [];
  const runtimeCall = async (_connection: unknown, operation: WithMateMemoryRuntimeOperation) => {
    operations.push(operation);
    if (operation.path === "/v1/runtime_status" || operation.path === "/v1/runtime_instances") return { ok: true, status: 200, value: { ok: true, applicationInstanceId: "owner", runtimeGenerationId: "generation", buildChannel: "development" } };
    return { ok: false, status: 403, value: { schemaVersion: "withmate-memory-v1", error: { code: "MEMORY_FORBIDDEN", message: "denied", effect: "none" } } };
  };
  const server = createWithMateMemoryMcpServer({ env, runtimeCall });
  const client = new Client({ name: "parity-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const [command, input] of samples) {
      operations.length = 0;
      const mcp = await client.callTool({ name: withMateMemoryToolName(command), arguments: input as Record<string, unknown> });
      const mcpOperation = operations[0];
      let output = "";
      const exitCode = await runWithMateMemoryCli([command.replaceAll("_", "-"), "--json", JSON.stringify(input)], { env, runtimeCall, stdout: { write: (value) => { output += value; return true; } } });
      assert.equal(exitCode, command === "status" || command === "instances" ? 0 : 3, command);
      assert.ok(mcpOperation, `${command} must dispatch`);
      assert.deepEqual(operations[1], mcpOperation, command);
      assert.deepEqual(JSON.parse(output), mcp.structuredContent, command);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "ローカルschema/validateはCLIとMCPで同じ公開契約とdefaultを返し、Characterの明示要求条件を維持する"
// oracle = { type = "contract", ref = "docs/runbooks/memory-affect-mcp.md ローカル説明と入力検証" }
// fault = "CLIだけが旧schemaやdefaultを使い、明示要求なしのAffect訂正をvalidとする"
// observable = "CLI JSONとMCP structuredContentのschema一覧、正規化入力及びinvalid-input error"
// observation_boundary = "public-boundary"
// scope = "memory-cli-mcp-local-contract"
// lifecycle = "permanent"
// @end-test-value
it("schemaとlocal validationの結果を両入口で同じにする", async () => {
  const server = createWithMateMemoryMcpServer({ env: {} });
  const client = new Client({ name: "local-parity-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let output = "";
    await runWithMateMemoryCli(["schema"], { env: {}, stdout: { write: (value) => { output += value; return true; } } });
    const schema = await client.callTool({ name: "memory.schema", arguments: {} });
    assert.deepEqual(JSON.parse(output), schema.structuredContent);
    for (const [command, input] of [["context_get", {}], ["affect_reset", { layer: "session", expectedVersion: "version", reason: "reset", resetAt: "now", idempotencyKey: "key" }], ["search", { schemaVersion: "withmate-memory-v1", targets: [{ kind: "user-global" }], query: "query" }]] as const) {
      output = "";
      const local = await client.callTool({ name: "memory.validate", arguments: { command, input } });
      await runWithMateMemoryCli(["validate", "--command", command.replaceAll("_", "-"), "--json", JSON.stringify(input)], { env: {}, stdout: { write: (value) => { output += value; return true; } } });
      assert.deepEqual(JSON.parse(output), local.structuredContent, command);
      if (command !== "context_get") {
        const invalid = local.structuredContent as { error: { code: string; effect: string } };
        assert.equal(invalid.error.code, "WITHMATE_MEMORY_INVALID_INPUT", command);
        assert.equal(invalid.error.effect, "none", command);
      }
    }
    const valid = await client.callTool({ name: "memory.validate", arguments: { command: "context_get", input: {} } });
    assert.deepEqual((valid.structuredContent as { value: unknown }).value, { memoryLimit: 3 });
  } finally {
    await client.close();
    await server.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "bindingのownerに一致しない明示runtime selectorはCLIとMCPのどちらでもdispatch前に拒否する"
// oracle = { type = "contract", ref = "docs/runbooks/memory-affect-mcp.md Session bindingのowner制約" }
// fault = "binding ownerより明示selectorを優先又は無視して別runtimeへ要求する"
// observable = "両入口の拒否codeとruntime dispatch件数"
// observation_boundary = "public-boundary"
// scope = "memory-cli-mcp-owner-selector"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
it("binding ownerと異なるruntime selectorへ接続しない", async () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const boundEnv = { ...env, WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding", WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: owner, WITHMATE_MEMORY_RUNTIME_GENERATION_ID: owner };
  let dispatched = 0;
  const runtimeCall = async () => { dispatched++; return { ok: true, status: 200, value: {} }; };
  const server = createWithMateMemoryMcpServer({ env: boundEnv, applicationInstanceId: other, runtimeCall });
  const client = new Client({ name: "owner-parity-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const input = { targets: [{ kind: "user-global" }], query: "query" };
    const mcp = await client.callTool({ name: "memory.search", arguments: input });
    let output = "";
    const code = await runWithMateMemoryCli(["search", "--instance", other, "--json", JSON.stringify(input)], { env: boundEnv, runtimeCall, stdout: { write: (value) => { output += value; return true; } } });
    assert.equal(code, 3);
    assert.deepEqual(JSON.parse(output), mcp.structuredContent);
    assert.equal((mcp.structuredContent as { error: { code: string } }).error.code, "WITHMATE_RUNTIME_SELECTOR_INVALID");
    assert.equal(dispatched, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
