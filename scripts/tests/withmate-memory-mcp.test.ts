import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  CHARACTER_MCP_SERVER_INSTRUCTIONS,
  WITHMATE_MEMORY_MCP_TOOL_DEFINITIONS,
  createWithMateMemoryMcpServer,
} from "../withmate-memory-mcp.js";
import {
  createWithMateMemoryRuntimeChallenge,
  WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_NONCE_HEADER,
} from "../../src/memory-v6/memory-runtime-exchange.js";
import { encodeMemoryListTagsCursor } from "../../src/memory-v6/memory-validation.js";
import {
  verifyRuntimeIdentity,
  mapRuntimeHttpFailureToMemory,
  WithMateMemoryRuntimeExchangeError,
  WITHMATE_MEMORY_API_SECRET_HEADER,
  type WithMateMemoryRuntimeConnection,
  type WithMateMemoryRuntimeOperation,
  type WithMateMemoryRuntimeResponse,
} from "../withmate-memory-runtime-client.js";

it("一般Memoryの非domain HTTP failureは4xxをeffect none、write 5xxだけunknownにする", () => {
  for (const status of [403, 429]) {
    const rejected = { ok: false, status, value: { message: "rejected" } };
    assert.equal((mapRuntimeHttpFailureToMemory(rejected, "read") as any).error.effect, "none");
    assert.equal((mapRuntimeHttpFailureToMemory(rejected, "write") as any).error.effect, "none");
  }
  const unavailable = { ok: false, status: 500, value: { message: "internal" } };
  assert.equal((mapRuntimeHttpFailureToMemory(unavailable, "read") as any).error.effect, "none");
  assert.equal((mapRuntimeHttpFailureToMemory(unavailable, "write") as any).error.effect, "unknown");
});

it("一般Memoryのstructured errorはstatusとoperationに応じてeffectを補完し明示値を保持する", () => {
  const rejected = { schemaVersion: "withmate-memory-v1", error: { code: "MEMORY_FORBIDDEN", message: "forbidden" } };
  assert.equal((mapRuntimeHttpFailureToMemory({ ok: false, status: 403, value: rejected }, "write") as any).error.effect, "none");
  const internal = { schemaVersion: "withmate-memory-v1", error: { code: "MEMORY_INTERNAL_ERROR", message: "failed" } };
  assert.equal((mapRuntimeHttpFailureToMemory({ ok: false, status: 500, value: internal }, "read") as any).error.effect, "none");
  assert.equal((mapRuntimeHttpFailureToMemory({ ok: false, status: 500, value: internal }, "write") as any).error.effect, "unknown");
  const partial = { schemaVersion: "withmate-memory-v1", error: { code: "MEMORY_FILE_CLEANUP_FAILED", message: "partial", effect: "partial" } };
  assert.equal((mapRuntimeHttpFailureToMemory({ ok: false, status: 500, value: partial }, "write") as any).error.effect, "partial");
});

function createLegacyRuntimeCall(fetchImpl: typeof fetch) {
  return async (
    connection: WithMateMemoryRuntimeConnection,
    operation: WithMateMemoryRuntimeOperation,
    options: { signal: AbortSignal },
  ): Promise<WithMateMemoryRuntimeResponse> => {
    if (!await verifyRuntimeIdentity(connection.api, fetchImpl, options.signal)) {
      throw new WithMateMemoryRuntimeExchangeError("Runtime identity mismatch.", false);
    }
    let response: Response;
    try {
      response = await fetchImpl(`${connection.api.baseUrl}${operation.path}`, {
        method: operation.method,
        headers: {
          "Content-Type": "application/json",
          [WITHMATE_MEMORY_API_SECRET_HEADER]: connection.api.apiSecret,
          "x-withmate-memory-mcp-api-secret": connection.credential.adapterSecret,
        },
        body: JSON.stringify(operation.body),
        redirect: "error",
        signal: options.signal,
      });
    } catch (error) {
      throw new WithMateMemoryRuntimeExchangeError("Legacy test runtime request failed.", true, { cause: error });
    }
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      value: text.trim() ? JSON.parse(text) as unknown : {},
    };
  };
}

async function listenServer(server: ReturnType<typeof createServer>, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("WithMate Memory / Character Affect MCP contract", () => {
  it("2025-06-18 handshakeでserver nameとversionを公開する", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer();
    try {
      await server.connect(serverTransport);
      await clientTransport.start();
      const initialized = new Promise<Record<string, any>>((resolve, reject) => {
        clientTransport.onmessage = (message) => {
          if ("id" in message && message.id === 1) {
            if ("error" in message) {
              reject(new Error(JSON.stringify(message.error)));
              return;
            }
            resolve(message.result as Record<string, any>);
          }
        };
        clientTransport.onerror = reject;
      });
      await clientTransport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "withmate-protocol-contract-test", version: "1.0.0" },
        },
      });

      const result = await initialized;
      assert.equal(result.protocolVersion, "2025-06-18");
      assert.deepEqual(result.serverInfo, { name: "withmate-character-context", version: "1.0.0" });
    } finally {
      await clientTransport.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "tools/listは17 toolsのstrict actor-relative schema、identity-free Character context projection、effect contractを正本として公開する"
  // oracle = { type = "adr", ref = "ADR-024 tools/list operation contract" }
  // failure_mode = "caller identityやowner/scope schemaが再公開される、context private fieldが露出する、またはerror/effect annotationが欠落する"
  // scope = "withmate-memory-mcp-tools-list"
  // lifecycle = "permanent"
  // @end-test-value
  it("既存Character 6 toolsと一般Memory 11 toolsを完全schemaとannotation付きで公開する", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer();
    const client = new Client({ name: "withmate-mcp-contract-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.listTools();
      assert.deepEqual(
        result.tools.map((tool) => tool.name),
        WITHMATE_MEMORY_MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
      );
      for (const tool of result.tools) {
        assert.equal(tool.inputSchema.type, "object");
        assert.equal(tool.outputSchema?.type, "object");
        assert.equal(
          Object.prototype.hasOwnProperty.call(tool.outputSchema?.properties ?? {}, "error"),
          true,
          `${tool.name} must publish its structured error branch`,
        );
        assert.equal(Array.isArray(tool.outputSchema?.oneOf), true);
        assert.ok(tool.description?.trim());
        assert.equal(tool.annotations?.openWorldHint, false);
        assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
        assert.equal(typeof tool.annotations?.destructiveHint, "boolean");
        assert.equal(typeof tool.annotations?.idempotentHint, "boolean");
        if (tool.name.startsWith("memory.")) {
          const errorSchema = tool.outputSchema?.properties?.error as { required?: string[] } | undefined;
          assert.ok(errorSchema?.required?.includes("effect"), `${tool.name} must require error.effect`);
        }
      }
      const appendEpisode = result.tools.find((tool) => tool.name === "character_memory.append_episode");
      assert.match(appendEpisode?.description ?? "", /standalone/);
      assert.match(appendEpisode?.description ?? "", /character_affect\.appraise\.memoryEpisode/);
      assert.match(
        result.tools.find((tool) => tool.name === "character_affect.appraise")?.description ?? "",
        /never duplicated through character_memory\.append_episode/,
      );
      const episodeSchema = (appendEpisode?.inputSchema.properties?.episode ?? {}) as Record<string, unknown>;
      assert.ok(Array.isArray(episodeSchema.anyOf));
      assert.deepEqual(
        (episodeSchema.anyOf as Array<{ required?: string[] }>).map((branch) => branch.required?.sort()),
        [
          ["body", "observedFact", "preview", "title"],
          ["body", "characterObservation", "preview", "title"],
        ],
      );
      const correct = result.tools.find((tool) => tool.name === "character_memory.correct");
      const forget = result.tools.find((tool) => tool.name === "character_memory.forget");
      assert.equal(correct?.annotations?.destructiveHint, true);
      assert.equal(forget?.annotations?.destructiveHint, true);
      for (const toolName of [
        "character_affect.appraise",
        "character_memory.append_episode",
        "character_memory.correct",
        "character_memory.forget",
      ]) {
        const tool = result.tools.find((candidate) => candidate.name === toolName);
        assert.equal(
          Object.prototype.hasOwnProperty.call(tool?.inputSchema.properties ?? {}, "authority"),
          false,
          `${toolName} must not accept caller-asserted authority`,
        );
      }
      const appraise = result.tools.find((tool) => tool.name === "character_affect.appraise");
      const contextGet = result.tools.find((tool) => tool.name === "character_context.get");
      for (const tool of result.tools.filter((candidate) => candidate.name.startsWith("character_"))) {
        for (const identityField of ["userId", "characterId", "sessionId"]) {
          assert.equal(
            Object.prototype.hasOwnProperty.call(tool.inputSchema.properties ?? {}, identityField),
            false,
            `${tool.name} must not accept caller-asserted ${identityField}`,
          );
        }
      }
      assert.equal(
        Object.prototype.hasOwnProperty.call(contextGet?.inputSchema.properties ?? {}, "sessionId"),
        false,
        "character_context.get must resolve actor Session from runtime binding",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(appraise?.inputSchema.properties ?? {}, "sessionId"),
        false,
        "character_affect.appraise must resolve actor Session from runtime binding",
      );
      const affectCandidateItems = appraise?.inputSchema.properties?.candidates as {
        items?: { required?: string[]; properties?: { family?: { enum?: string[] }; sessionId?: unknown } };
      };
      assert.equal(
        Object.prototype.hasOwnProperty.call(affectCandidateItems.items?.properties ?? {}, "sessionId"),
        false,
        "affect candidates must not accept caller-asserted actor Session",
      );
      assert.ok(affectCandidateItems.items?.required?.includes("family"));
      assert.deepEqual(affectCandidateItems.items?.properties?.family?.enum, [
        "joy", "relief", "interest", "anticipation", "affinity", "gratitude",
        "concern", "frustration", "disappointment", "regret", "determination", "other",
      ]);
      const contextOutputProperties = contextGet?.outputSchema?.properties ?? {};
      assert.equal(Object.prototype.hasOwnProperty.call(contextOutputProperties, "characterId"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(contextOutputProperties, "sessionId"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(contextOutputProperties, "scope"), false);
      const contextMemoryItems = (contextOutputProperties.memory as {
        properties?: { items?: { items?: { properties?: Record<string, unknown>; required?: string[] } } };
      } | undefined)?.properties?.items?.items;
      assert.deepEqual(Object.keys(contextMemoryItems?.properties ?? {}).sort(), [
        "id", "preview", "tags", "title", "updatedAt",
      ]);
      assert.deepEqual([...(contextMemoryItems?.required ?? [])].sort(), [
        "id", "preview", "tags", "title", "updatedAt",
      ]);
      const unknownFamily = await client.callTool({
        name: "character_affect.appraise",
        arguments: {
          candidates: [{
            schemaVersion: "withmate-affect-v1",
            layer: "session",
            targetType: "task",
            targetId: "task-a",
            family: "unknown",
            value: { label: "free label", valence: 0 },
            intensity: 0.5,
            reason: "reason",
            evidence: "evidence",
            occurredAt: "2026-08-09T00:00:00.000Z",
            idempotencyKey: "unknown-family",
          }],
        },
      });
      assert.equal(unknownFamily.isError, true);
      for (const toolName of [
        "memory.append",
        "memory.forget",
        "memory.move_entry",
        "memory.get_file",
        "memory.export_files",
      ]) {
        const tool = result.tools.find((candidate) => candidate.name === toolName);
        assert.equal(
          Object.prototype.hasOwnProperty.call(tool?.inputSchema.properties ?? {}, "authority"),
          false,
          `${toolName} must not accept caller-asserted authority`,
        );
      }
      for (const toolName of ["memory.append", "memory.forget", "memory.move_entry"]) {
        const tool = result.tools.find((candidate) => candidate.name === toolName);
        assert.ok(tool?.inputSchema.required?.includes("idempotencyKey"));
      }
      assert.ok(result.tools.find((tool) => tool.name === "memory.forget")?.inputSchema.required?.includes("reason"));
      assert.ok(result.tools.find((tool) => tool.name === "memory.move_entry")?.inputSchema.required?.includes("reason"));
      assert.equal(result.tools.find((tool) => tool.name === "memory.get_file")?.annotations?.idempotentHint, false);
      assert.equal(result.tools.find((tool) => tool.name === "memory.export_files")?.annotations?.idempotentHint, false);
      assert.equal(result.tools.find((tool) => tool.name === "memory.forget")?.annotations?.destructiveHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "memory.move_entry")?.annotations?.destructiveHint, true);
      const memorySearchDescription = result.tools.find((tool) => tool.name === "memory.search")?.description ?? "";
      assert.match(memorySearchDescription, /same exact target/);
      assert.match(memorySearchDescription, /withmate-memory <command> --fallback-from mcp/);
      assert.match(memorySearchDescription, /only after MCP initialize and tools\/list succeeded/);
      assert.match(memorySearchDescription, /Never fallback for domain, authority, version, idempotency, migration, or storage errors/);
      const searchTargetBranches = (result.tools.find((tool) => tool.name === "memory.search")
        ?.inputSchema.properties?.targets as { items?: { oneOf?: Array<{ properties?: Record<string, unknown> }> } })
        ?.items?.oneOf ?? [];
      assert.equal(searchTargetBranches.length, 4);
      assert.equal(searchTargetBranches.some((branch) => "owner" in (branch.properties ?? {})), false);
      assert.equal(searchTargetBranches.some((branch) => "scope" in (branch.properties ?? {})), false);
      const searchOutputEntryProperties = (result.tools.find((tool) => tool.name === "memory.search")
        ?.outputSchema?.properties?.items as { items?: { properties?: Record<string, unknown> } })
        ?.items?.properties ?? {};
      assert.equal(Object.prototype.hasOwnProperty.call(searchOutputEntryProperties, "target"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(searchOutputEntryProperties, "owner"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(searchOutputEntryProperties, "scope"), false);
      const fileUsageTool = result.tools.find((tool) => tool.name === "memory.file_usage");
      assert.deepEqual(Object.keys(fileUsageTool?.inputSchema.properties ?? {}), []);
      assert.equal(
        Object.prototype.hasOwnProperty.call(fileUsageTool?.outputSchema?.properties ?? {}, "largestEntries"),
        false,
      );
      const listEntriesSchema = result.tools.find((tool) => tool.name === "memory.list_entries")?.inputSchema;
      assert.equal((listEntriesSchema?.properties?.states as { minItems?: number })?.minItems, 1);
      const listTagsSchema = result.tools.find((tool) => tool.name === "memory.list_tags")?.inputSchema;
      assert.equal(
        result.tools.find((tool) => tool.name === "memory.list_tags")?.description,
        "List tags for one explicit Memory target, optionally with bounded counts and samples.",
      );
      assert.equal((listTagsSchema?.properties?.targets as { minItems?: number; maxItems?: number })?.minItems, 1);
      assert.equal((listTagsSchema?.properties?.targets as { minItems?: number; maxItems?: number })?.maxItems, 1);
      assert.equal((listTagsSchema?.properties?.sampleLimit as { maximum?: number })?.maximum, 50);
      assert.equal((listTagsSchema?.properties?.limit as { maximum?: number })?.maximum, 200);
      assert.equal((listTagsSchema?.properties?.cursor as { maxLength?: number })?.maxLength, 500);
      const listTagsOutput = result.tools.find((tool) => tool.name === "memory.list_tags")?.outputSchema;
      assert.equal(Object.prototype.hasOwnProperty.call(listTagsOutput?.properties ?? {}, "nextCursor"), true);
      assert.deepEqual((listTagsSchema?.allOf as unknown[] | undefined)?.[0], {
        if: { required: ["sampleLimit"] },
        then: { properties: { withCounts: { const: true } }, required: ["withCounts"] },
      });
      const absolutePathPattern = "^(?:\\/|[A-Za-z]:[\\\\/]|\\\\\\\\)";
      const collectPropertyPatterns = (value: unknown, propertyName: string): string[] => {
        if (typeof value !== "object" || value === null) {
          return [];
        }
        const record = value as Record<string, unknown>;
        const properties = record.properties as Record<string, { pattern?: unknown }> | undefined;
        const ownPattern = typeof properties?.[propertyName]?.pattern === "string"
          ? [properties[propertyName].pattern as string]
          : [];
        return ownPattern.concat(Object.values(record).flatMap((child) => collectPropertyPatterns(child, propertyName)));
      };
      const projectPathPatterns = collectPropertyPatterns(
        result.tools.find((tool) => tool.name === "memory.search")?.inputSchema,
        "path",
      );
      assert.ok(projectPathPatterns.length > 0);
      assert.ok(projectPathPatterns.every((pattern) => pattern === absolutePathPattern));
      const characterProjectPathPatterns = collectPropertyPatterns(
        result.tools.find((tool) => tool.name === "character_memory.search")?.inputSchema,
        "path",
      );
      assert.ok(characterProjectPathPatterns.length > 0);
      assert.ok(characterProjectPathPatterns.every((pattern) => pattern === absolutePathPattern));
      const appendFiles = result.tools.find((tool) => tool.name === "memory.append")
        ?.inputSchema.properties?.files as { items?: { properties?: { path?: { pattern?: string } } } };
      assert.equal(appendFiles.items?.properties?.path?.pattern, absolutePathPattern);
      assert.equal(
        (result.tools.find((tool) => tool.name === "memory.get_file")?.inputSchema.properties?.outputPath as { pattern?: string })?.pattern,
        absolutePathPattern,
      );
      assert.equal(
        (result.tools.find((tool) => tool.name === "memory.export_files")?.inputSchema.properties?.outputDirectoryPath as { pattern?: string })?.pattern,
        absolutePathPattern,
      );
      assert.match(CHARACTER_MCP_SERVER_INSTRUCTIONS, /Character's own affect/);
      assert.match(CHARACTER_MCP_SERVER_INSTRUCTIONS, /raw conversation transcript/);
      assert.match(CHARACTER_MCP_SERVER_INSTRUCTIONS, /autonomous user-delegate operations/);
      assert.match(CHARACTER_MCP_SERVER_INSTRUCTIONS, /memory\.\*/);
      assert.match(CHARACTER_MCP_SERVER_INSTRUCTIONS, /domain, authority, version, idempotency, migration, and storage failures do not permit fallback/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "一般Memory toolはactor-relative inputを対応runtime routeへ送りdomain rejectionを変更せず返す"
  // oracle = { type = "adr", ref = "ADR-024 exact MCP schema and failure boundary" }
  // failure_mode = "MCP adapterがrouteまたはdomain errorを別の成功・fallback条件へ変換する"
  // scope = "general-memory-mcp-runtime-adapter"
  // lifecycle = "permanent"
  // @end-test-value
  it("一般Memory toolはMemory V1 requestを同じruntime routeへ送りdomain errorを保持する", async () => {
    const operations: WithMateMemoryRuntimeOperation[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: "api-secret",
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
      },
      runtimeCall: async (_connection, operation) => {
        operations.push(operation);
        if (operation.path === "/v1/search") {
          return {
            ok: true,
            status: 200,
            value: { schemaVersion: "withmate-memory-v1", items: [] },
          };
        }
        return {
          ok: false,
          status: 404,
          value: {
            schemaVersion: "withmate-memory-v1",
            error: { code: "MEMORY_TARGET_NOT_FOUND", message: "Memory target was not found.", field: "target.project" },
          },
        };
      },
    });
    const client = new Client({ name: "withmate-general-memory-routing-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const search = await client.callTool({
        name: "memory.search",
        arguments: {
          targets: [{ kind: "user-global" }],
          query: "shared preference",
        },
      });
      assert.equal(search.isError, undefined);
      assert.deepEqual(search.structuredContent, { schemaVersion: "withmate-memory-v1", items: [] });

      const missing = await client.callTool({
        name: "memory.get_entry",
        arguments: {
          entryId: "entry-a",
          target: { kind: "project", project: { type: "id", id: "missing" } },
        },
      });
      assert.equal(missing.isError, true);
      assert.deepEqual((missing.structuredContent as any).error, {
        code: "MEMORY_TARGET_NOT_FOUND",
        message: "Memory target was not found.",
        field: "target.project",
        effect: "none",
      });
      assert.deepEqual(operations, [
        {
          method: "POST",
          path: "/v1/search",
          body: {
            schemaVersion: "withmate-memory-v1",
            targets: [{ kind: "user-global" }],
            query: "shared preference",
          },
        },
        {
          method: "POST",
          path: "/v1/get_entry",
          body: {
            schemaVersion: "withmate-memory-v1",
            entryId: "entry-a",
            target: { kind: "project", project: { type: "id", id: "missing" } },
          },
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "opaque runtime bindingはrequest payloadではなく専用transport optionだけへ伝搬する"
  // oracle = { type = "adr", ref = "ADR-024 runtime binding authority boundary" }
  // failure_mode = "binding referenceがAgent-visible payloadへ混入する、またはruntimeへ伝搬されない"
  // scope = "memory-mcp-binding-transport"
  // lifecycle = "permanent"
  // @end-test-value
  it("managed MCPはopaque runtime bindingを専用runtime exchange optionへだけ渡す", async () => {
    const bindingReferences: Array<string | undefined> = [];
    const operations: WithMateMemoryRuntimeOperation[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: "api-secret",
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "opaque-binding-reference",
      },
      runtimeCall: async (_connection, operation, options) => {
        operations.push(operation);
        bindingReferences.push(options.bindingReference);
        return {
          ok: false,
          status: 403,
          value: {
            schemaVersion: "withmate-memory-v1",
            error: { code: "MEMORY_UNAUTHORIZED", message: "rejected", effect: "none" },
          },
        };
      },
    });
    const client = new Client({ name: "withmate-runtime-binding-transport-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({
        name: "memory.search",
        arguments: {
          targets: [{ kind: "user-global" }],
          query: "binding transport",
        },
      });
      assert.deepEqual(bindingReferences, ["opaque-binding-reference"]);
      assert.equal(JSON.stringify(operations).includes("opaque-binding-reference"), false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "binding必須のmanaged MCPはbinding欠落をruntime dispatch前に拒否する"
  // oracle = { type = "adr", ref = "ADR-024 managed MCP binding requirement" }
  // failure_mode = "bindingなしのAgent requestがlocal-user authorityへdowngradeしてdispatchされる"
  // scope = "memory-mcp-binding-preflight"
  // lifecycle = "permanent"
  // @end-test-value
  it("managed MCPはrequired binding欠落をdispatch前のnon-retryable rejectionとして返す", async () => {
    let runtimeDispatchCount = 0;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: "api-secret",
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
        WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
      },
      runtimeCall: async () => {
        runtimeDispatchCount += 1;
        throw new Error("must not dispatch");
      },
    });
    const client = new Client({ name: "withmate-runtime-binding-required-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const characterResult = await client.callTool({
        name: "character_context.get",
        arguments: {},
      });
      const memoryResult = await client.callTool({
        name: "memory.search",
        arguments: {
          targets: [{ kind: "user-global" }],
          query: "binding required",
        },
      });

      assert.equal((characterResult.structuredContent as any).error.code, "authority_denied");
      assert.equal((characterResult.structuredContent as any).error.retryable, false);
      assert.equal((characterResult.structuredContent as any).error.effect, "none");
      assert.equal((memoryResult.structuredContent as any).error.code, "WITHMATE_MEMORY_CLI_USAGE");
      assert.equal((memoryResult.structuredContent as any).error.retryable, false);
      assert.equal((memoryResult.structuredContent as any).error.effect, "none");
      assert.equal(runtimeDispatchCount, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "一般Memoryのpost-dispatch response lossはreadをeffect none、writeをeffect unknownとして区別する"
  // oracle = { type = "adr", ref = "ADR-024 effect certainty" }
  // failure_mode = "response loss後にwrite未実行または成功を断定し、安全でない自動retryを許す"
  // scope = "general-memory-mcp-effect-certainty"
  // lifecycle = "permanent"
  // @end-test-value
  it("一般Memoryのresponse lossはreadをeffect none、writeをeffect unknownにする", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: "api-secret",
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
      },
      runtimeCall: async () => {
        throw new WithMateMemoryRuntimeExchangeError("response lost", true);
      },
    });
    const client = new Client({ name: "withmate-general-memory-effect-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const read = await client.callTool({
        name: "memory.search",
        arguments: { targets: [{ kind: "user-global" }], query: "preference" },
      });
      const write = await client.callTool({
        name: "memory.append",
        arguments: {
          target: { kind: "user-global" },
          kind: "preference",
          title: "Editor preference",
          body: "Use a compact editor layout.",
          preview: "Compact editor layout.",
          tags: [{ type: "topic", value: "editor" }],
          idempotencyKey: "general-effect-1",
        },
      });
      assert.equal((read.structuredContent as any).error.effect, "none");
      assert.equal((write.structuredContent as any).error.effect, "unknown");
      assert.equal((write.structuredContent as any).error.code, "WITHMATE_MEMORY_TRANSPORT_ERROR");
      const dryRun = await client.callTool({
        name: "memory.forget",
        arguments: {
          target: { kind: "user-global" },
          entryIds: ["entry-a"],
          reason: "user_request",
          idempotencyKey: "general-effect-dry-run-1",
          dryRun: true,
        },
      });
      assert.equal((dryRun.structuredContent as any).error.effect, "none");
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "非idempotentなfile exportはtools/listで自動再試行禁止と復旧手順を公開し、dispatch後のresponse lossをeffect unknownとして一度のdispatchで終了する"
  // oracle = { type = "adr", ref = "ADR 024 tools/list operation contract" }
  // failure_mode = "Agentが応答喪失後にfile exportを自動再試行し、既存出力との衝突またはeffect certaintyの誤認を起こす"
  // scope = "withmate-memory-mcp-file-export"
  // lifecycle = "permanent"
  // distinction = "idempotency keyを持つMemory mutationのreconcileではなく、keyを持たないget_fileとexport_filesのresponse-loss recoveryを検証する"
  // @end-test-value
  it("非idempotent file exportはresponse loss後に自動再試行せず復旧契約を公開する", async () => {
    const operations: WithMateMemoryRuntimeOperation[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: "api-secret",
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
      },
      runtimeCall: async (_connection, operation) => {
        operations.push(operation);
        throw new WithMateMemoryRuntimeExchangeError("response lost", true);
      },
    });
    const client = new Client({ name: "withmate-file-export-effect-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const getFile = tools.tools.find((tool) => tool.name === "memory.get_file");
      const exportFiles = tools.tools.find((tool) => tool.name === "memory.export_files");
      for (const tool of [getFile, exportFiles]) {
        assert.equal(tool?.annotations?.idempotentHint, false);
        assert.match(tool?.description ?? "", /effect as unknown and do not retry automatically/);
        assert.match(tool?.description ?? "", /operator manual recovery/);
      }
      const target = { kind: "user-global" } as const;
      const getFileResult = await client.callTool({
        name: "memory.get_file",
        arguments: {
          target,
          objectId: "object-a",
          outputPath: "C:\\exports\\memory.txt",
        },
      });
      const exportFilesResult = await client.callTool({
        name: "memory.export_files",
        arguments: {
          target,
          entryId: "entry-a",
          outputDirectoryPath: "C:\\exports\\entry-a",
        },
      });

      assert.ok(getFileResult.structuredContent, JSON.stringify(getFileResult));
      assert.ok(exportFilesResult.structuredContent, JSON.stringify(exportFilesResult));
      assert.equal((getFileResult.structuredContent as any).error.effect, "unknown");
      assert.equal((exportFilesResult.structuredContent as any).error.effect, "unknown");
      assert.deepEqual(operations.map((operation) => operation.path), ["/v1/get_file", "/v1/export_files"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "memory.list_tagsはcanonical sample limitとpagination cursorをruntime requestへ保持する"
  // oracle = { type = "schema", ref = "Memory V1 list-tags request schema" }
  // failure_mode = "MCP schemaまたはadapterがsample上限・cursorを欠落させ異なる一覧を返す"
  // scope = "general-memory-list-tags-mcp-schema"
  // lifecycle = "permanent"
  // @end-test-value
  it("memory.list_tagsはcanonical sample上限とpaginationをruntime routeへ送る", async () => {
    const cursor = encodeMemoryListTagsCursor({
      usageCount: 3,
      latestUpdatedAt: "2026-08-13T00:00:00.000Z",
      canonicalType: "topic",
      canonicalValue: "memory",
    });
    const operations: WithMateMemoryRuntimeOperation[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: "api-secret",
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
      },
      runtimeCall: async (_connection, operation) => {
        operations.push(operation);
        return {
          ok: true,
          status: 200,
          value: { schemaVersion: "withmate-memory-v1", tags: [] },
        };
      },
    });
    const client = new Client({ name: "withmate-list-tags-limit-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "memory.list_tags",
        arguments: {
          targets: [{ kind: "user-global" }],
          withCounts: true,
          sampleLimit: 50,
          limit: 200,
          cursor,
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(operations, [{
        method: "POST",
        path: "/v1/list_tags",
        body: {
          schemaVersion: "withmate-memory-v1",
          targets: [{ kind: "user-global" }],
          withCounts: true,
          sampleLimit: 50,
          limit: 200,
          cursor,
        },
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

// @test-value v1
// kind = "regression"
// claim = "不正selectorをdispatch前にstructured errorへ変換する"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "別instanceへfallbackする"
// scope = "memory-mcp-discovery"
// lifecycle = "permanent"
// @end-test-value
it("不正な明示runtime URLはCharacterと一般Memoryでstructured pre-dispatch errorを返す", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1.evil.example:4567",
        WITHMATE_MEMORY_API_SECRET: "api-secret",
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
      },
    });
    const client = new Client({ name: "withmate-invalid-runtime-url-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const character = await client.callTool({
        name: "character_context.get",
        arguments: {},
      });
      const memory = await client.callTool({
        name: "memory.append",
        arguments: {
          target: { kind: "user-global" },
          kind: "preference",
          title: "Editor preference",
          body: "Use a compact editor layout.",
          preview: "Compact editor layout.",
          tags: [{ type: "topic", value: "editor" }],
          idempotencyKey: "invalid-runtime-url-1",
        },
      });
      assert.equal(character.isError, true);
      assert.deepEqual(character.structuredContent, {
        schemaVersion: "withmate-character-context-v1",
        error: {
          code: "storage_unavailable",
          message: "WithMate runtime discovery could not select a runtime.",
          retryable: false,
          conversationMayContinue: true,
          effect: "none",
          details: { discoveryCode: "WITHMATE_RUNTIME_SELECTOR_INVALID", candidates: [] },
        },
      });
      assert.equal(memory.isError, true);
      assert.deepEqual(memory.structuredContent, {
        schemaVersion: "withmate-memory-v1",
        error: {
          code: "WITHMATE_RUNTIME_SELECTOR_INVALID",
          message: "WithMate Memory runtime discovery could not select a runtime.",
          retryable: false,
          conversationMayContinue: true,
          effect: "none",
          details: { discoveryCode: "WITHMATE_RUNTIME_SELECTOR_INVALID", candidates: [] },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

// @test-value v1
// kind = "regression"
// claim = "runtime unavailableはCharacter context readをtool errorとして返し成功へ変換しない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "停止runtimeからCharacter contextを取得できたように扱う"
// scope = "memory-mcp-discovery"
// lifecycle = "permanent"
// @end-test-value
it("runtime unavailableをtool successにせず、retryabilityとconversation継続可否を返す", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "0",
        WITHMATE_MEMORY_DISCOVERY_FILE: "Z:/missing/withmate-memory.json",
      },
      registryRootDirectoryPath: "Z:/missing/withmate-runtime-registry",
    });
    const client = new Client({ name: "withmate-mcp-unavailable-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();
      const result = await client.callTool({
        name: "character_context.get",
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        schemaVersion: "withmate-character-context-v1",
        error: {
          code: "storage_unavailable",
          message: "WithMate runtime discovery could not select a runtime.",
          retryable: true,
          conversationMayContinue: true,
          effect: "none",
          details: { discoveryCode: "WITHMATE_RUNTIME_UNAVAILABLE", candidates: [] },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "runtimeのHTTP non-2xxはMCP tool errorとして返り成功へ変換されない"
  // oracle = { type = "adr", ref = "ADR-024 transport and domain error contract" }
  // failure_mode = "runtime rejectionをtool successとしてAgentが受理する"
  // scope = "character-memory-mcp-http-error"
  // lifecycle = "permanent"
  // @end-test-value
  it("runtimeのHTTP non-2xxをtool successへ変換しない", async () => {
    const apiSecret = "api-secret";
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: apiSecret,
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
      },
      runtimeCall: createLegacyRuntimeCall(async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/v1/status") {
          const nonce = parsed.searchParams.get("nonce")!;
          return new Response(JSON.stringify({
            runtimeInstanceId: "runtime-a",
            challenge: {
              nonce,
              hmacSha256: createHmac("sha256", apiSecret).update(nonce, "utf8").digest("base64url"),
            },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          schemaVersion: "withmate-memory-v1",
          error: { code: "MEMORY_REQUEST_TOO_LARGE", message: "too large" },
        }), { status: 413 });
      }),
    });
    const client = new Client({ name: "withmate-mcp-http-error-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "character_context.get",
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        schemaVersion: "withmate-character-context-v1",
        error: {
          code: "invalid_input",
          message: "WithMate runtime rejected the Character context request.",
          retryable: false,
          conversationMayContinue: true,
          effect: "none",
          details: { httpStatus: 413 },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Character MCPのpost-dispatch response lossはreadをeffect none、writeをeffect unknownとして区別する"
  // oracle = { type = "adr", ref = "ADR-024 effect certainty" }
  // failure_mode = "Character mutationのresponse lossを未実行または成功と断定して重複mutationを招く"
  // scope = "character-memory-mcp-effect-certainty"
  // lifecycle = "permanent"
  // @end-test-value
  it("post-dispatch response lossはreadをeffect none、writeをeffect unknownにする", async () => {
    const apiSecret = "effect-api-secret";
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: apiSecret,
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-effect",
      },
      runtimeCall: createLegacyRuntimeCall(async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/v1/status") {
          const nonce = parsed.searchParams.get("nonce")!;
          return new Response(JSON.stringify({
            runtimeInstanceId: "runtime-effect",
            challenge: {
              nonce,
              hmacSha256: createHmac("sha256", apiSecret).update(nonce, "utf8").digest("base64url"),
            },
          }), { status: 200 });
        }
        throw new TypeError("response lost after dispatch");
      }),
    });
    const client = new Client({ name: "withmate-mcp-effect-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const readResult = await client.callTool({
        name: "character_context.get",
        arguments: {},
      });
      const writeResult = await client.callTool({
        name: "character_memory.forget",
        arguments: {
          entryId: "entry-a",
          reason: "user_request",
          idempotencyKey: "effect-mcp-1",
        },
      });
      assert.equal((readResult.structuredContent as any).error.effect, "none");
      assert.equal((writeResult.structuredContent as any).error.effect, "unknown");
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "dispatch前に確定した同期failureはwrite要求でもeffect noneを返す"
  // oracle = { type = "adr", ref = "ADR-024 failure timing and effect certainty" }
  // failure_mode = "未dispatchのwriteをeffect unknownとして不要なreconcile対象にする"
  // scope = "character-memory-mcp-predispatch-effect"
  // lifecycle = "permanent"
  // @end-test-value
  it("pre-dispatch同期failureはwriteでもeffect noneを返す", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: "api-secret",
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
      },
      runtimeCall: async () => {
        throw new TypeError("invalid request header");
      },
    });
    const client = new Client({ name: "withmate-mcp-predispatch-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "character_memory.forget",
        arguments: {
          entryId: "entry-a",
          reason: "user_request",
          idempotencyKey: "predispatch-mcp-1",
        },
      });
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as any).error.effect, "none");
    } finally {
      await client.close();
      await server.close();
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "runtime authority rejectionは共通Character error schemaのauthority_deniedとして返る"
  // oracle = { type = "adr", ref = "ADR-024 authority error contract" }
  // failure_mode = "authority rejectionがstorage failureまたは成功へ誤分類されfallback迂回を許す"
  // scope = "character-memory-mcp-authority-error"
  // lifecycle = "permanent"
  // @end-test-value
  it("runtimeのauthority errorを共通Character schemaへ変換する", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:4567",
        WITHMATE_MEMORY_API_SECRET: "api-secret",
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
      },
      runtimeCall: async () => ({
        ok: false,
        status: 401,
        value: { schemaVersion: "withmate-memory-v1", error: { code: "MEMORY_UNAUTHORIZED", message: "rejected" } },
      }),
    });
    const client = new Client({ name: "withmate-mcp-authority-error-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "character_context.get",
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as any).schemaVersion, "withmate-character-context-v1");
      assert.equal((result.structuredContent as any).error.code, "authority_denied");
      assert.equal((result.structuredContent as any).error.effect, "none");
      assert.equal((result.structuredContent as any).error.details.httpStatus, 401);
    } finally {
      await client.close();
      await server.close();
    }
  });

// @test-value v1
// kind = "security"
// claim = "challenge後のpeer差替えでMCP dispatchを再実行しない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "偽peerへcredentialを再送する"
// scope = "memory-mcp-transport"
// lifecycle = "permanent"
// @end-test-value
it("challenge後に同じportのpeerが差し替わってもcredentialとmutationを再送せず偽成功を拒否する", async () => {
    const apiSecret = "swap-api-secret";
    const runtimeInstanceId = "swap-runtime";
    let replacementRequests = 0;
    let replacementServer: ReturnType<typeof createServer> | null = null;
    let replacementListening: Promise<void> | null = null;
    const firstHeaders: Array<Record<string, string | string[] | undefined>> = [];
    const firstServer = createServer((request, response) => {
      firstHeaders.push(request.headers);
      const nonce = request.headers[WITHMATE_MEMORY_RUNTIME_NONCE_HEADER];
      response.writeEarlyHints({
        link: "</v1/exchange>; rel=preconnect",
        [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: runtimeInstanceId,
        [WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER]: createWithMateMemoryRuntimeChallenge(
          apiSecret,
          runtimeInstanceId,
          typeof nonce === "string" ? nonce : "",
        ),
      }, () => {
        request.socket.destroy();
        firstServer.close(() => {
          replacementServer = createServer((_replacementRequest, replacementResponse) => {
            replacementRequests += 1;
            replacementResponse.writeHead(200, { "Content-Type": "application/json" });
            replacementResponse.end(JSON.stringify({ ok: true, forged: true }));
          });
          replacementListening = listenServer(replacementServer, port).then(() => undefined);
        });
      });
    });
    const port = await listenServer(firstServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: {
        WITHMATE_MEMORY_API_URL: `http://127.0.0.1:${port}`,
        WITHMATE_MEMORY_API_SECRET: apiSecret,
        WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: runtimeInstanceId,
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "opaque-swap-binding",
      },
    });
    const client = new Client({ name: "withmate-mcp-peer-swap-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "character_memory.forget",
        arguments: {
          entryId: "entry-a",
          reason: "user_request",
          idempotencyKey: "swap-mcp-1",
        },
      });
      if (replacementListening) {
        await replacementListening;
      }
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as any).error.code, "storage_unavailable");
      assert.equal((result.structuredContent as any).error.effect, "none");
      assert.equal(replacementRequests, 0);
      assert.equal(firstHeaders.length, 1);
      assert.equal(firstHeaders[0]["x-withmate-memory-api-secret"], undefined);
      assert.equal(firstHeaders[0]["x-withmate-memory-mcp-api-secret"], undefined);
      assert.equal(firstHeaders[0]["x-withmate-agent-runtime-binding-reference"], undefined);
      assert.equal(firstHeaders[0]["content-length"], undefined);
    } finally {
      await client.close();
      await server.close();
      await closeServer(firstServer);
      if (replacementListening) {
        await replacementListening.catch(() => undefined);
      }
      if (replacementServer) {
        await closeServer(replacementServer);
      }
    }
  });
});
