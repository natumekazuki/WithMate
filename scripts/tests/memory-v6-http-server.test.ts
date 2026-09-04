import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { MemoryProtectedObjectImportError } from "../../src-electron/memory-protected-object-importer.js";
import {
  DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createMemoryV6HttpServer,
  isLoopbackListenHost,
  isLoopbackRemoteAddress,
  resolveMemoryV6RouteTimeoutMs,
  type MemoryV6HttpServer,
  type MemoryV6HttpServerOptions,
} from "../../src-electron/memory-v6-http-server.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/provider-agent-runtime-turn-coordinator.js";
import { MemoryV6Service, type MemoryV6ServiceDeps } from "../../src-electron/memory-v6-service.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";
import { callWithMateMemoryRuntime } from "../withmate-memory-runtime-client.js";

const TEST_API_SECRET = "test-secret";
const TEST_OPERATOR_API_SECRET = "test-operator-secret";
const TEST_MCP_API_SECRET = "test-mcp-secret";
const TEST_RUNTIME_INSTANCE_ID = "test-runtime";

async function withMemoryApi<T>(
  runner: (input: { baseUrl: string; storage: MemoryV6Storage; server: MemoryV6HttpServer }) => T | Promise<T>,
  overrides: Partial<Pick<MemoryV6ServiceDeps, "protectedObjectImporter">> = {},
  serverOverrides: Partial<MemoryV6HttpServerOptions> = {},
): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-http-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
  const storage = new MemoryV6Storage(dbPath);
  const service = new MemoryV6Service({
    storage,
    listCharacters: () => [{
      id: "mika",
      name: "Mika",
      description: "Guitar",
      iconFilePath: "",
      theme: { main: "#111111", sub: "#222222" },
      state: "active",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      archivedAt: null,
    }],
    resolveProjectById: (id) => ({ id, displayName: id }),
    resolveProjectByPath: (projectPath) => projectPath === "C:/workspace/project-a"
      ? { id: "project-a", displayName: "Project A" }
      : null,
    resolveKnownProjectByPath: (projectPath) => projectPath === "C:/workspace/project-a"
      ? { id: "project-a", displayName: "Project A" }
      : null,
    ...(overrides.protectedObjectImporter ? { protectedObjectImporter: overrides.protectedObjectImporter } : {}),
  });
  const server = createMemoryV6HttpServer({
    service,
    apiSecret: TEST_API_SECRET,
    operatorApiSecret: TEST_OPERATOR_API_SECRET,
    mcpApiSecret: TEST_MCP_API_SECRET,
    runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
    maxBodyBytes: 1024,
    ...serverOverrides,
  });

  try {
    await server.start();
    const address = server.address();
    assert.ok(address);
    return await runner({ baseUrl: `http://127.0.0.1:${address.port}`, storage, server });
  } finally {
    await server.stop();
    storage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function postJson(baseUrl: string, path: string, body: unknown, apiSecret = TEST_API_SECRET): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WithMate-Memory-Api-Secret": apiSecret,
      "X-WithMate-Memory-Operator-Api-Secret": TEST_OPERATOR_API_SECRET,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

function appendRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    target: {
      owner: "project",
      scope: "project",
      project: { type: "path", path: "C:/workspace/project-a" },
    },
    kind: "decision",
    title: "localhost API方針",
    body: "Memory localhost APIはservice境界を薄く包む。",
    preview: "localhost APIはservice境界を薄く包む。",
    tags: [{ type: "topic", value: "memory-api" }],
    ...overrides,
  };
}

describe("MemoryV6HttpServer", () => {
  it("loopback addressだけを許可対象にする", () => {
    assert.equal(isLoopbackRemoteAddress("127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("127.12.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("::1"), true);
    assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("192.168.0.10"), false);
    assert.equal(isLoopbackRemoteAddress(undefined), false);
    assert.equal(isLoopbackListenHost("localhost"), true);
    assert.equal(isLoopbackListenHost("0.0.0.0"), false);
  });

  it("file operation routeは通常requestと別のtimeoutを使う", () => {
    assert.equal(resolveMemoryV6RouteTimeoutMs("search"), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(resolveMemoryV6RouteTimeoutMs("get_file"), DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS);
    assert.equal(resolveMemoryV6RouteTimeoutMs("export_files", { fileOperationRequestTimeoutMs: 20_000 }), 20_000);
    assert.equal(resolveMemoryV6RouteTimeoutMs("append", { requestTimeoutMs: 123 }), DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS);
    assert.equal(resolveMemoryV6RouteTimeoutMs("file_usage", { requestTimeoutMs: 123 }), 123);
  });

// @test-value v1
// kind = "security"
// claim = "status challengeはapplication instanceとMemory generationを安全なmetadataとして返し、owner tupleをHMACで検証できる"
// oracle = { type = "adr", ref = "ADR-023 multi-instance-runtime-discovery" }
// failure_mode = "resolverが別instanceまたは別generationを同一runtimeと誤認し、credential送信前のidentity検証を通過させる"
// scope = "memory-runtime-identity-challenge"
// lifecycle = "permanent"
// @end-test-value
it("status はapplication instance、generation、build channelとowner challengeを返す", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const status = await fetch(`${baseUrl}/v1/status`);
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), {
        ok: true,
        applicationInstanceId: "legacy",
        runtimeGenerationId: TEST_RUNTIME_INSTANCE_ID,
        runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
        buildChannel: "unknown",
      });

      const nonce = "nonce-a";
      const challengedStatus = await fetch(`${baseUrl}/v1/status?nonce=${nonce}`);
      assert.equal(challengedStatus.status, 200);
      assert.deepEqual(await challengedStatus.json(), {
        ok: true,
        applicationInstanceId: "legacy",
        runtimeGenerationId: TEST_RUNTIME_INSTANCE_ID,
        runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
        buildChannel: "unknown",
        challenge: {
          nonce,
          hmacSha256: createHmac("sha256", TEST_API_SECRET).update(nonce, "utf8").digest("base64url"),
          ownerHmacSha256: createHmac("sha256", TEST_API_SECRET)
            .update(`legacy\n${TEST_RUNTIME_INSTANCE_ID}\n${nonce}`, "utf8")
            .digest("base64url"),
        },
      });

      const context = await postJson(baseUrl, "/v1/context", { schemaVersion: MEMORY_V6_SCHEMA_VERSION });
      assert.equal(context.status, 404);
      assert.equal(context.json.error.code, "MEMORY_ROUTE_NOT_FOUND");
    });
  });

  it("apiSecretなしではserverを作成できず、secretなしのrequestを拒否する", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      assert.throws(() => createMemoryV6HttpServer({
        service: {} as MemoryV6Service,
        apiSecret: "",
        runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
      }), /apiSecret/);

      const missingSecret = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION }),
      });
      assert.equal(missingSecret.status, 401);
      assert.equal((await missingSecret.json()).error.code, "MEMORY_UNAUTHORIZED");

      const wrongSecret = await postJson(baseUrl, "/v1/search", { schemaVersion: MEMORY_V6_SCHEMA_VERSION }, "wrong-secret");
      assert.equal(wrongSecret.status, 401);
      assert.equal(wrongSecret.json.error.code, "MEMORY_UNAUTHORIZED");
    });
  });

  // @test-value v1
  // kind = "security"
  // claim = "MCP credentialだけではagent-facing routeを実行できず、operator credentialとのroute境界も維持する"
  // oracle = { type = "adr", ref = "ADR-024 general Memory binding policy" }
  // failure_mode = "unbound MCPがlocal-userへdowngradeする、またはMCPからoperator-only routeへ到達する"
  // scope = "memory-http-adapter-authority"
  // lifecycle = "permanent"
  // @end-test-value
  it("共通apiSecretだけでは実行できず、MCP credentialはbindingなしで公開routeへ到達しない", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const body = appendRequest({ idempotencyKey: "unauthorized-mcp-append" });
      const missingAdapter = await fetch(`${baseUrl}/v1/append`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
        },
        body: JSON.stringify(body),
      });
      assert.equal(missingAdapter.status, 403);
      assert.equal((await missingAdapter.json()).error.code, "MEMORY_FORBIDDEN");

      const mcpAppend = await fetch(`${baseUrl}/v1/append`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Mcp-Api-Secret": TEST_MCP_API_SECRET,
        },
        body: JSON.stringify(body),
      });
      assert.equal(mcpAppend.status, 401);

      const mcpAudit = await fetch(`${baseUrl}/v1/audit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Mcp-Api-Secret": TEST_MCP_API_SECRET,
        },
        body: JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, allTargets: true }),
      });
      assert.equal(mcpAudit.status, 403);
      assert.equal((await mcpAudit.json()).error.code, "MEMORY_FORBIDDEN");

      const search = await postJson(baseUrl, "/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        query: "localhost",
      });
      assert.equal(search.status, 200);
      assert.equal(search.json.items.length, 0);
    });
  });

// @test-value v1
// kind = "security"
// claim = "bound MCPはactor-relative targetとcurrent turn capabilityを検証してから公開routeだけをdispatchする"
// oracle = { type = "adr", ref = "ADR-024 actor-relative Memory target and turn capability" }
// failure_mode = "caller identity、未許可Project、stale capabilityまたは非公開routeがapplication副作用へ到達する"
// scope = "memory-runtime-mcp-exchange"
// lifecycle = "permanent"
// @end-test-value
it("MCP credentialは公開した一般Memory routeだけをruntime exchange経由で実行できる", async () => {
    const bindings = new AgentRuntimeBindingRegistry();
    const turns = new ProviderAgentRuntimeTurnCoordinator();
    const binding = bindings.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: {
        userId: "local-user",
        characterId: "mika",
        allowedProjectIds: ["project-a"],
      },
      operationGrants: [
        "memory.route.search",
        "memory.route.append",
        "memory.route.forget",
      ],
    });
    const turn = turns.begin({ actorSessionId: "session-a", providerId: "codex" });
    await withMemoryApi(async ({ baseUrl }) => {
      const connection = {
        api: {
          baseUrl,
          apiSecret: TEST_API_SECRET,
          runtimeGenerationId: TEST_RUNTIME_INSTANCE_ID,
          runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
        },
        credential: {
          adapter: "mcp" as const,
          adapterSecret: TEST_MCP_API_SECRET,
        },
      };
      const call = (path: string, body: unknown, turnCapability = turn.capability) => callWithMateMemoryRuntime(connection, {
        method: "POST",
        path,
        body,
      }, {
        signal: new AbortController().signal,
        bindingReference: binding.bindingReference,
        turnCapability,
      });

      const search = await call("/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ kind: "user-global" }],
        query: "preference",
      });
      assert.equal(search.status, 200);
      assert.deepEqual((search.value as any).items, []);

      const callerIdentity = await call("/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        userId: "local-user",
        targets: [{ kind: "user-global" }],
        query: "preference",
      });
      assert.equal(callerIdentity.status, 422);
      assert.equal((callerIdentity.value as any).error.field, "userId");
      assert.equal((callerIdentity.value as any).error.effect, "none");

      const unallowedProject = await call("/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ kind: "project", project: { type: "id", id: "project-b" } }],
        query: "preference",
      });
      assert.equal(unallowedProject.status, 422);
      assert.equal((unallowedProject.value as any).error.field, "targets");
      assert.equal((unallowedProject.value as any).error.effect, "none");

      const staleAppend = await call("/v1/append", {
        ...appendRequest({ idempotencyKey: "stale-turn-append" }),
        target: { kind: "project", project: { type: "id", id: "project-a" } },
      }, "stale-turn-capability");
      assert.equal(staleAppend.status, 403);
      assert.equal((staleAppend.value as any).error.code, "MEMORY_FORBIDDEN");
      assert.equal((staleAppend.value as any).error.effect, "none");

      const appendWithoutIdempotency = await call("/v1/append", {
        ...appendRequest({ idempotencyKey: undefined }),
        target: { kind: "project", project: { type: "id", id: "project-a" } },
      });
      assert.equal(appendWithoutIdempotency.status, 422);
      assert.equal((appendWithoutIdempotency.value as any).error.code, "MEMORY_INVALID_FIELD");
      assert.equal((appendWithoutIdempotency.value as any).error.field, "idempotencyKey");
      assert.equal((appendWithoutIdempotency.value as any).error.effect, "none");

      const forgetWithoutReason = await call("/v1/forget", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { kind: "user-global" },
        entryIds: ["entry-a"],
        idempotencyKey: "mcp-forget-policy",
      });
      assert.equal(forgetWithoutReason.status, 422);
      assert.equal((forgetWithoutReason.value as any).error.field, "reason");
      assert.equal((forgetWithoutReason.value as any).error.effect, "none");

      const audit = await call("/v1/audit", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        allTargets: true,
      });
      assert.equal(audit.status, 403);
      assert.equal((audit.value as any).error.code, "MEMORY_FORBIDDEN");

      const affectInspect = await call("/v1/character_affect/inspect", {
        schemaVersion: "withmate-character-context-v1",
        characterId: "mika",
        sessionId: "session-a",
      });
      assert.equal(affectInspect.status, 403);
      assert.equal((affectInspect.value as any).error.code, "authority_denied");
    }, {}, {
      agentRuntimeBindingRegistry: bindings,
      providerAgentRuntimeTurns: turns,
      resolveActorSession: (sessionId) => sessionId === "session-a"
        ? { id: "session-a", providerId: "codex", characterId: "mika", workspacePath: "C:/workspace/project-a" }
        : null,
      resolveProjectById: (id) => id === "project-a" ? { id, displayName: "Project A" } : null,
      resolveKnownProjectByPath: (path) => path === "C:/workspace/project-a"
        ? { id: "project-a", displayName: "Project A" }
        : null,
    });
    turns.end(turn);
  });

  it("append / search / get_entry / list_tags / forget をlocal_userとしてdispatchする", async () => {
    await withMemoryApi(async ({ baseUrl, storage }) => {
      const characters = await fetch(`${baseUrl}/v1/characters`, {
        headers: {
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Operator-Api-Secret": TEST_OPERATOR_API_SECRET,
        },
      });
      assert.equal(characters.status, 200);
      const charactersJson = await characters.json();
      assert.deepEqual(charactersJson.characters, [{
        id: "mika",
        name: "Mika",
        description: "Guitar",
      }]);
      assert.equal("isDefault" in charactersJson.characters[0], false);
      assert.equal("iconFilePath" in charactersJson.characters[0], false);
      assert.equal("theme" in charactersJson.characters[0], false);

      const fileUsage = await fetch(`${baseUrl}/v1/file-usage`, {
        headers: {
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Operator-Api-Secret": TEST_OPERATOR_API_SECRET,
        },
      });
      assert.equal(fileUsage.status, 200);
      const fileUsageJson = await fileUsage.json();
      assert.equal(fileUsageJson.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
      assert.equal(fileUsageJson.usedBytes, 0);
      assert.equal(fileUsageJson.objectCount, 0);

      const largestFileUsage = await fetch(`${baseUrl}/v1/file-usage?largest=1&limit=5`, {
        headers: {
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Operator-Api-Secret": TEST_OPERATOR_API_SECRET,
        },
      });
      assert.equal(largestFileUsage.status, 200);
      const largestFileUsageJson = await largestFileUsage.json();
      assert.deepEqual(largestFileUsageJson.largestEntries, []);

      const append = await postJson(baseUrl, "/v1/append", appendRequest({ idempotencyKey: "append-key-http" }));
      assert.equal(append.status, 200);
      assert.equal(append.json.created, true);
      assert.equal(append.json.entry.owner.id, "project-a");

      const search = await postJson(baseUrl, "/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        query: "localhost",
      });
      assert.equal(search.status, 200);
      assert.deepEqual(search.json.items.map((item: { id: string }) => item.id), [append.json.entry.id]);

      const detail = await postJson(baseUrl, "/v1/get_entry", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.json.entry.id,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      });
      assert.equal(detail.status, 200);
      assert.equal(detail.json.entry.source.providerId, "local-user");

      const getFile = await postJson(baseUrl, "/v1/get_file", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        objectId: "a".repeat(32),
        outputPath: "C:/exports/file.bin",
      });
      assert.equal(getFile.status, 422);
      assert.equal(getFile.json.error.code, "MEMORY_FILE_EXPORT_UNIMPLEMENTED");

      const exportFiles = await postJson(baseUrl, "/v1/export_files", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryId: append.json.entry.id,
        outputDirectoryPath: "C:/exports",
      });
      assert.equal(exportFiles.status, 422);
      assert.equal(exportFiles.json.error.code, "MEMORY_FILE_EXPORT_UNIMPLEMENTED");

      const tags = await postJson(baseUrl, "/v1/list_tags", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      });
      assert.equal(tags.status, 200);
      assert.deepEqual(tags.json.tags, [{ type: "topic", value: "memory-api" }]);

      const invalidTagCursor = await postJson(baseUrl, "/v1/list_tags", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        cursor: "cursor-a",
      });
      assert.equal(invalidTagCursor.status, 422);
      assert.equal(invalidTagCursor.json.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(invalidTagCursor.json.error.field, "cursor");
      assert.equal(invalidTagCursor.json.error.effect, "none");
      const nonCanonicalTagCursor = await postJson(baseUrl, "/v1/list_tags", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        cursor: "tag-v1:1:2026-08-13T00%3A00%3A00.000Z:topic:%6demory",
      });
      assert.equal(nonCanonicalTagCursor.status, 422);
      assert.equal(nonCanonicalTagCursor.json.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(nonCanonicalTagCursor.json.error.effect, "none");

      const forget = await postJson(baseUrl, "/v1/forget", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: [append.json.entry.id],
        reason: "privacy",
      });
      assert.equal(forget.status, 200);
      assert.deepEqual(forget.json.results, [{ entryId: append.json.entry.id, status: "forgotten" }]);
      assert.equal(storage.getEntry(append.json.entry.id)?.state, "forgotten");
    });
  });

  it("appendのimporter由来errorを500にせずdomain errorで返す", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const append = await postJson(baseUrl, "/v1/append", appendRequest({
        files: [{
          path: "C:/trace/missing.png",
          summary: "Missing screenshot.",
          role: "evidence",
        }],
      }));

      assert.equal(append.status, 422);
      assert.equal(append.json.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(append.json.error.field, "files[0].path");
    }, {
      protectedObjectImporter: {
        inspect: async () => {
          throw new MemoryProtectedObjectImportError(
            "MEMORY_INVALID_FIELD",
            "path",
            "Memory protected object input file is not readable.",
          );
        },
        prepare: async () => {
          throw new Error("prepare should not be called");
        },
      },
    });
  });

  it("appendのprepare失敗も500にせずfile import domain errorで返す", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const append = await postJson(baseUrl, "/v1/append", appendRequest({
        files: [{
          path: "C:/trace/dialog.png",
          summary: "Dialog screenshot.",
          role: "evidence",
        }],
      }));

      assert.equal(append.status, 422);
      assert.equal(append.json.error.code, "MEMORY_FILE_IMPORT_FAILED");
      assert.equal(append.json.error.field, "files[0]");
    }, {
      protectedObjectImporter: {
        inspect: async () => ({
          originalBytes: 128,
          role: "evidence",
          mediaKind: "image",
          contentType: "image/png",
          displayName: "dialog.png",
          summary: "Dialog screenshot.",
        }),
        prepare: async () => {
          throw new Error("safe storage unavailable");
        },
      },
    });
  });

  it("maintenance routesはinventory、listing、dry-run、moveをservice境界へ通す", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const append = await postJson(baseUrl, "/v1/append", appendRequest({ idempotencyKey: "http-maintenance-append" }));
      assert.equal(append.status, 200);
      const entryId = append.json.entry.id;

      const targets = await postJson(baseUrl, "/v1/list_targets", { schemaVersion: MEMORY_V6_SCHEMA_VERSION });
      assert.equal(targets.status, 200);
      assert.equal(targets.json.items[0].entryCount, 1);

      const entries = await postJson(baseUrl, "/v1/list_entries", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      });
      assert.equal(entries.status, 200);
      assert.equal(entries.json.items[0].id, entryId);
      assert.equal("body" in entries.json.items[0], false);

      const dryRun = await postJson(baseUrl, "/v1/forget", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: [entryId],
        dryRun: true,
      });
      assert.equal(dryRun.status, 200);
      assert.equal(dryRun.json.writeOccurred, false);

      const moved = await postJson(baseUrl, "/v1/move_entry", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId,
        from: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        to: { owner: "user", scope: "global" },
        reason: "move to user scope",
        idempotencyKey: "http-maintenance-move",
      });
      assert.equal(moved.status, 200);
      assert.equal(moved.json.entry.owner.type, "user");
    });
  });

  it("invalid route / method / JSON / body sizeをtransport errorで返す", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const missing = await fetch(`${baseUrl}/v1/missing`, {
        method: "POST",
        headers: {
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Operator-Api-Secret": TEST_OPERATOR_API_SECRET,
        },
        body: "{}",
      });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, "MEMORY_ROUTE_NOT_FOUND");

      const invalidMethod = await fetch(`${baseUrl}/v1/search`, {
        headers: {
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Operator-Api-Secret": TEST_OPERATOR_API_SECRET,
        },
      });
      assert.equal(invalidMethod.status, 405);
      assert.equal((await invalidMethod.json()).error.code, "MEMORY_METHOD_NOT_ALLOWED");

      const invalidJson = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Operator-Api-Secret": TEST_OPERATOR_API_SECRET,
        },
        body: "{",
      });
      assert.equal(invalidJson.status, 400);
      assert.equal((await invalidJson.json()).error.code, "MEMORY_INVALID_JSON");

      const tooLarge = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Operator-Api-Secret": TEST_OPERATOR_API_SECRET,
        },
        body: JSON.stringify({ payload: "x".repeat(1600) }),
      });
      assert.equal(tooLarge.status, 413);
      assert.equal((await tooLarge.json()).error.code, "MEMORY_REQUEST_TOO_LARGE");
    });
  });
});
