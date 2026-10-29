import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src-shared/memory/memory-contract.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { MemoryProtectedObjectImportError } from "../../src-electron/memory/memory-protected-object-importer.js";
import {
  DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createMemoryV6HttpServer,
  getMemoryV6AgentRuntimeOperations,
  isLoopbackListenHost,
  isLoopbackRemoteAddress,
  resolveMemoryV6RouteTimeoutMs,
  type MemoryV6HttpServer,
  type MemoryV6HttpServerOptions,
} from "../../src-electron/memory/memory-v6-http-server.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { MemoryV6Service, type MemoryV6ServiceDeps } from "../../src-electron/memory/memory-v6-service.js";
import { MemoryV6Storage } from "../../src-electron/memory/memory-v6-storage.js";
import type { CharacterContextApplicationService } from "../../src-electron/character/character-context-application-service.js";
import { callWithMateMemoryRuntime } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";

const TEST_API_SECRET = "test-secret";
const TEST_OPERATOR_API_SECRET = "test-operator-secret";
const TEST_MCP_API_SECRET = "test-mcp-secret";
const TEST_RUNTIME_INSTANCE_ID = "test-runtime";
const sessionCalls = new Map<string, (path: string, body: unknown, method?: "GET" | "POST") => Promise<{ status: number; json: any }>>();

async function withMemoryApi<T>(
  runner: (input: { baseUrl: string; storage: MemoryV6Storage; server: MemoryV6HttpServer }) => T | Promise<T>,
  overrides: Partial<Pick<MemoryV6ServiceDeps, "protectedObjectImporter">> = {},
  serverOverrides: Partial<MemoryV6HttpServerOptions> = {},
): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-http-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
  const storage = new MemoryV6Storage(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`INSERT INTO characters (id,name,created_at,updated_at) VALUES ('mika','Mika','2026-01-01','2026-01-01');
    INSERT INTO sessions_v6 (id,title,state,provider_id,catalog_revision,model_id,approval_mode,character_id,character_snapshot_json,created_at,updated_at,last_active_at)
    VALUES ('session-a','A','active','codex',1,'model','on-request','mika','{}','2026-01-01','2026-01-01','2026-01-01');`);
  db.close();
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const binding = bindings.issueOrReuse({
    actorSessionId: "session-a", providerId: "codex",
    authoritySnapshot: { userId: "local-user", characterId: "mika", allowedProjectIds: ["project-a"] },
    operationGrants: getMemoryV6AgentRuntimeOperations(),
  });
  const turn = turns.begin({ actorSessionId: "session-a", providerId: "codex" });
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
    agentRuntimeBindingRegistry: bindings,
    providerAgentRuntimeTurns: turns,
    resolveActorSession: () => ({ id: "session-a", providerId: "codex", characterId: "mika" }),
    resolveProjectById: (id) => ({ id, displayName: id }),
    resolveProjectByPath: (projectPath) => projectPath === "C:/workspace/project-a"
      ? { id: "project-a", displayName: "Project A" } : null,
    ...serverOverrides,
  });

  try {
    await server.start();
    const address = server.address();
    assert.ok(address);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    sessionCalls.set(baseUrl, async (path, body, method = "POST") => {
      const response = await callWithMateMemoryRuntime({
        api: { baseUrl, apiSecret: TEST_API_SECRET, runtimeGenerationId: TEST_RUNTIME_INSTANCE_ID, runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID },
        credential: { adapter: "cli", adapterSecret: TEST_OPERATOR_API_SECRET },
      }, { method, path, body }, {
        signal: new AbortController().signal, bindingReference: binding.bindingReference, turnCapability: turn.capability,
      });
      return { status: response.status, json: response.value };
    });
    try { return await runner({ baseUrl, storage, server }); }
    finally { sessionCalls.delete(baseUrl); }
  } finally {
    await server.stop();
    storage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function postJson(baseUrl: string, path: string, body: unknown, apiSecret = TEST_API_SECRET): Promise<{ status: number; json: any }> {
  if (apiSecret === TEST_API_SECRET) return sessionCalls.get(baseUrl)!(path, body);
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
      kind: "project",
      project: { type: "path", path: "C:/workspace/project-a" },
    },
    kind: "decision",
    title: "localhost API方針",
    body: "Memory localhost APIはservice境界を薄く包む。",
    preview: "localhost APIはservice境界を薄く包む。",
    tags: [{ type: "topic", value: "memory-api" }],
    idempotencyKey: "append-default-key",
    ...overrides,
  };
}

describe("MemoryV6HttpServer", () => {
  // @test-value v2
  // kind = "security"
  // claim = "Affect inspect/correct/resetはbinding actorを補完し、訂正/resetには明示要求を必要とする"
  // oracle = { type = "contract", ref = "Issue #905 context-dependent Affect authorization" }
  // fault = "caller identityや明示要求なしの訂正がapplication serviceへ渡る"
  // observable = "runtime拒否statusとapplication service境界で受信したactor identity・authority"
  // observation_boundary = "component-behavior"
  // scope = "Memory HTTP Affect route authorization and actor injection"
  // lifecycle = "permanent"
  // impact = "別Sessionの感情状態変更と明示要求を伴わない訂正を防ぐ"
  // distinction = "application service単体のauthority検証でなくruntimeが生成するrequestを観測する"
  // @end-test-value
  it("Affect保守操作はbinding actorと明示指示をapplication境界へ渡す", async () => {
    const calls: Array<{ operation: string; body: any }> = [];
    const receive = (operation: string) => async (body: unknown) => {
      calls.push({ operation, body });
      return { schemaVersion: "withmate-character-context-v1", accepted: true };
    };
    const characterContextService = {
      inspectAffect: receive("inspect"), correctAffect: receive("correct"), resetAffect: receive("reset"),
    } as unknown as CharacterContextApplicationService;
    await withMemoryApi(async ({ baseUrl }) => {
      const schemaVersion = "withmate-character-context-v1";
      const inspect = await postJson(baseUrl, "/v1/character_affect/inspect", { schemaVersion });
      assert.equal(inspect.status, 200);
      assert.equal(calls[0].body.characterId, "mika");
      assert.equal(calls[0].body.sessionId, "session-a");
      for (const operation of ["correct", "reset"]) {
        const path = `/v1/character_affect/${operation}`;
        const denied = await postJson(baseUrl, path, { schemaVersion, reason: "user requested" });
        assert.equal(denied.status, 422);
        const accepted = await postJson(baseUrl, path, {
          schemaVersion, reason: "user requested", explicitUserRequest: true,
          ...(operation === "correct" ? { replacement: { label: "corrected" } } : {}),
        });
        assert.equal(accepted.status, 200);
        const last = calls.at(-1)!;
        assert.equal(last.body.characterId, "mika");
        assert.equal(last.body.sessionId, "session-a");
        assert.deepEqual(last.body.authority, { kind: "explicit_user_instruction", reason: "user requested" });
        assert.equal(Object.hasOwn(last.body, "explicitUserRequest"), false);
        if (operation === "correct") {
          assert.equal(last.body.replacement.characterId, "mika");
          assert.equal(last.body.replacement.sessionId, "session-a");
          assert.equal(last.body.replacement.userId, "local-user");
        }
        const caller = await postJson(baseUrl, path, { schemaVersion, explicitUserRequest: true, reason: "reason", characterId: "other" });
        assert.equal(caller.status, 422);
      }
      assert.equal(calls.length, 3);
    }, {}, { characterContextService });
  });
  // @test-value v2
  // kind = "security"
  // claim = "認証済み無binding入口は一般Memoryを扱い、Character対象と無効bindingの降格を拒否する"
  // oracle = { type = "contract", ref = "Issue #905 context-dependent binding authorization" }
  // fault = "無binding Character要求を実行するか、提示された無効bindingを無視してlocal-userへ降格する"
  // observable = "CLI/MCP credential経由のpublic target、拒否status、error effect、保存件数"
  // observation_boundary = "public-boundary"
  // scope = "Memory runtime context-dependent binding"
  // lifecycle = "permanent"
  // impact = "一般Memoryを維持しながらCharacter/Session情報の不正参照を防ぐ"
  // distinction = "型やschemaだけでは検出できないruntime認証・binding解決・storage結果を両transportで観測する"
  // @end-test-value
  it("CLIとMCPは一般Memoryを無bindingで扱いCharacter要求と無効bindingを拒否する", async () => {
    await withMemoryApi(async ({ baseUrl, storage }) => {
      for (const adapter of ["cli", "mcp"] as const) {
        const connection = {
          api: { baseUrl, apiSecret: TEST_API_SECRET, runtimeGenerationId: TEST_RUNTIME_INSTANCE_ID, runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID },
          credential: { adapter, adapterSecret: adapter === "cli" ? TEST_OPERATOR_API_SECRET : TEST_MCP_API_SECRET },
        };
        const call = (path: string, body: unknown, bindingReference?: string) => callWithMateMemoryRuntime(connection, {
          method: "POST", path, body,
        }, { signal: new AbortController().signal, ...(bindingReference === undefined ? {} : { bindingReference }) });
        const appended = await call("/v1/append", appendRequest({ idempotencyKey: `unbound-${adapter}` }));
        assert.equal(appended.status, 200);
        assert.deepEqual((appended.value as any).entry.target, { kind: "project", project: { type: "id", id: "project-a" } });
        for (const targets of [[{ kind: "character" }], [{ kind: "user-global" }, { kind: "character" }]]) {
          const denied = await call("/v1/search", { schemaVersion: MEMORY_V6_SCHEMA_VERSION, query: "memory", targets });
          assert.equal(denied.status, 401);
          assert.equal((denied.value as any).error.effect, "none");
        }
        for (const path of ["/v1/list_targets", "/v1/audit"]) {
          const denied = await call(path, { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...(path.endsWith("audit") ? { allTargets: true } : {}) });
          assert.equal(denied.status, 401);
        }
        const invalid = await call("/v1/append", appendRequest({ idempotencyKey: `invalid-${adapter}` }), "invalid-binding");
        assert.equal(invalid.status, 403);
        assert.equal((invalid.value as any).error.effect, "none");
      }
      assert.equal(storage.listEntries({ target: { owner: { type: "project", id: "project-a" }, scope: { type: "project", id: "project-a" } }, limit: 50 }).items.length, 2);
    });
  });
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

// @test-value v2
// kind = "security"
// claim = "status challengeはapplication instanceとMemory generationを安全なmetadataとして返し、owner tupleをHMACで検証できる"
// oracle = { type = "adr", ref = "ADR-023 multi-instance-runtime-discovery" }
// fault = "resolverが別instanceまたは別generationを同一runtimeと誤認し、credential送信前のidentity検証を通過させる"
// observable = "statusのowner tupleとnonce challenge HMAC"
// observation_boundary = "public-boundary"
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

  // @test-value v2
  // kind = "security"
  // claim = "Memory HTTP serverはapiSecret未設定で起動せず、未認証または誤ったsecretのrequestを401で拒否する"
  // oracle = { type = "contract", ref = "memory-v6-http-authentication" }
  // fault = "空secretでserverを起動する、または認証失敗を成功応答や別のroute errorへ変換する"
  // observable = "createMemoryV6HttpServerのthrowと、secretなし/誤secretのHTTP status・error.code"
  // observation_boundary = "public-boundary"
  // scope = "memory-http-adapter-authentication"
  // lifecycle = "permanent"
  // @end-test-value
  it("apiSecretなしではserverを作成できず、secretなしのrequestを拒否する", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      assert.throws(() => createMemoryV6HttpServer({
        service: {} as MemoryV6Service,
        apiSecret: "",
        operatorApiSecret: "operator-secret",
        mcpApiSecret: "mcp-secret",
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

  // @test-value v2
  // kind = "security"
  // claim = "adapter認証が一般Memory実行の前提となり、Characterを暗黙に含む全target監査はbindingを要求する"
  // oracle = { type = "adr", ref = "ADR-024 general Memory binding policy" }
  // fault = "adapter credentialなしで実行するか、無bindingの全target監査へCharacter情報を含める"
  // observable = "adapter credential有無のHTTP statusとaudit拒否error code"
  // observation_boundary = "public-boundary"
  // scope = "memory-http-adapter-authority"
  // lifecycle = "permanent"
  // @end-test-value
  it("共通apiSecretだけでは実行できずMCPの一般Memoryと全target監査を文脈で認可する", async () => {
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
      assert.equal(mcpAppend.status, 200);

      const mcpAudit = await fetch(`${baseUrl}/v1/audit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
          "X-WithMate-Memory-Mcp-Api-Secret": TEST_MCP_API_SECRET,
        },
        body: JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, allTargets: true }),
      });
      assert.equal(mcpAudit.status, 401);
      assert.equal((await mcpAudit.json()).error.code, "MEMORY_PRINCIPAL_REQUIRED");

      const search = await postJson(baseUrl, "/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ kind: "project", project: { type: "id", id: "project-a" } }],
        query: "localhost",
      });
      assert.equal(search.status, 200);
      assert.equal(search.json.items.length, 1);
    });
  });

// @test-value v2
// kind = "security"
// claim = "bound MCPはactor-relative targetとcurrent turn capabilityを検証してから公開routeだけをdispatchする"
// oracle = { type = "adr", ref = "ADR-024 actor-relative Memory target and turn capability" }
// fault = "caller identity、未許可Project、stale capabilityまたは未grant操作がapplication副作用へ到達する"
// observable = "runtime exchangeのstatusとfield・effectを含む拒否error"
// observation_boundary = "public-boundary"
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

  // @test-value v2
  // kind = "contract"
  // claim = "Session-bound CLI credentialはactor-relative一般Memory CRUDと許可されたinventoryを同じruntimeで実行する"
  // oracle = { type = "contract", ref = "Issue #905 Session-bound Memory runtime" }
  // fault = "CLI transportがbindingを無視するかCRUDを異なるtargetへdispatchする"
  // observable = "HTTP runtimeのstatus、返却target、検索ID、忘却後storage state"
  // observation_boundary = "public-boundary"
  // scope = "Session-bound Memory runtime exchange"
  // lifecycle = "permanent"
  // @end-test-value
  it("append / search / get_entry / list_tags / forget をSessionとしてdispatchする", async () => {
    await withMemoryApi(async ({ baseUrl, storage }) => {
      const characters = await sessionCalls.get(baseUrl)!("/v1/characters", {}, "GET");
      assert.equal(characters.status, 200);
      const charactersJson = characters.json;
      assert.deepEqual(charactersJson.characters, [{
        id: "mika",
        name: "Mika",
        description: "Guitar",
      }]);
      assert.equal("isDefault" in charactersJson.characters[0], false);
      assert.equal("iconFilePath" in charactersJson.characters[0], false);
      assert.equal("theme" in charactersJson.characters[0], false);

      const fileUsage = await sessionCalls.get(baseUrl)!("/v1/file-usage", {}, "GET");
      assert.equal(fileUsage.status, 200);
      const fileUsageJson = fileUsage.json;
      assert.equal(fileUsageJson.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
      assert.equal(fileUsageJson.usedBytes, 0);
      assert.equal(fileUsageJson.objectCount, 0);

      const largestFileUsage = await sessionCalls.get(baseUrl)!("/v1/file-usage?largest=1&limit=5", {}, "GET");
      assert.equal(largestFileUsage.status, 200);
      const largestFileUsageJson = largestFileUsage.json;
      assert.deepEqual(largestFileUsageJson.largestEntries, []);

      const append = await postJson(baseUrl, "/v1/append", appendRequest({ idempotencyKey: "append-key-http" }));
      assert.equal(append.status, 200);
      assert.equal(append.json.created, true);
      assert.equal(append.json.entry.target.project.id, "project-a");

      const search = await postJson(baseUrl, "/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ kind: "project", project: { type: "id", id: "project-a" } }],
        query: "localhost",
      });
      assert.equal(search.status, 200);
      assert.deepEqual(search.json.items.map((item: { id: string }) => item.id), [append.json.entry.id]);

      const detail = await postJson(baseUrl, "/v1/get_entry", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.json.entry.id,
        target: { kind: "project", project: { type: "id", id: "project-a" } },
      });
      assert.equal(detail.status, 200);
      assert.equal(detail.json.entry.source.providerId, "codex");

      const getFile = await postJson(baseUrl, "/v1/get_file", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { kind: "project", project: { type: "id", id: "project-a" } },
        objectId: "a".repeat(32),
        outputPath: "C:/exports/file.bin",
      });
      assert.equal(getFile.status, 422);
      assert.equal(getFile.json.error.code, "MEMORY_FILE_EXPORT_UNIMPLEMENTED");

      const exportFiles = await postJson(baseUrl, "/v1/export_files", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { kind: "project", project: { type: "id", id: "project-a" } },
        entryId: append.json.entry.id,
        outputDirectoryPath: "C:/exports",
      });
      assert.equal(exportFiles.status, 422);
      assert.equal(exportFiles.json.error.code, "MEMORY_FILE_EXPORT_UNIMPLEMENTED");

      const tags = await postJson(baseUrl, "/v1/list_tags", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ kind: "project", project: { type: "id", id: "project-a" } }],
      });
      assert.equal(tags.status, 200);
      assert.deepEqual(tags.json.tags, [{ type: "topic", value: "memory-api" }]);

      const invalidTagCursor = await postJson(baseUrl, "/v1/list_tags", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ kind: "project", project: { type: "id", id: "project-a" } }],
        cursor: "cursor-a",
      });
      assert.equal(invalidTagCursor.status, 422);
      assert.equal(invalidTagCursor.json.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(invalidTagCursor.json.error.field, "cursor");
      assert.equal(invalidTagCursor.json.error.effect, "none");
      const nonCanonicalTagCursor = await postJson(baseUrl, "/v1/list_tags", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ kind: "project", project: { type: "id", id: "project-a" } }],
        cursor: "tag-v1:1:2026-08-13T00%3A00%3A00.000Z:topic:%6demory",
      });
      assert.equal(nonCanonicalTagCursor.status, 422);
      assert.equal(nonCanonicalTagCursor.json.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(nonCanonicalTagCursor.json.error.effect, "none");

      const forget = await postJson(baseUrl, "/v1/forget", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { kind: "project", project: { type: "id", id: "project-a" } },
        entryIds: [append.json.entry.id],
        reason: "privacy",
        idempotencyKey: "http-forget-key",
      });
      assert.equal(forget.status, 200);
      assert.deepEqual(forget.json.results, [{ entryId: append.json.entry.id, status: "forgotten" }]);
      assert.equal(storage.getEntry(append.json.entry.id)?.state, "forgotten");
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "認可済みfile appendのinspect失敗はHTTP domain errorとして返る"
  // oracle = { type = "contract", ref = "Memory protected object importer error contract" }
  // fault = "importerの入力失敗を500または成功へ変換する"
  // observable = "HTTP status、error.code、error.field"
  // observation_boundary = "public-boundary"
  // scope = "Memory runtime file import inspect failure"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "認可済みfile appendのprepare失敗はHTTP domain errorとして返る"
  // oracle = { type = "contract", ref = "Memory protected object importer error contract" }
  // fault = "importer prepare失敗を500または成功へ変換する"
  // observable = "HTTP status、MEMORY_FILE_IMPORT_FAILED、files field"
  // observation_boundary = "public-boundary"
  // scope = "Memory runtime file import prepare failure"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "Session-bound maintenance操作はinventory・listing・dry-run・moveをpublic target契約で実行する"
  // oracle = { type = "contract", ref = "Issue #905 shared Memory runtime" }
  // fault = "認可済みmaintenance要求が実行されないかdry-runが保存を変更する"
  // observable = "runtimeのentryCount、listing ID、writeOccurred、移動先public target"
  // observation_boundary = "public-boundary"
  // scope = "Session-bound Memory maintenance routes"
  // lifecycle = "permanent"
  // @end-test-value
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
        target: { kind: "project", project: { type: "id", id: "project-a" } },
      });
      assert.equal(entries.status, 200);
      assert.equal(entries.json.items[0].id, entryId);
      assert.equal("body" in entries.json.items[0], false);

      const dryRun = await postJson(baseUrl, "/v1/forget", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { kind: "project", project: { type: "id", id: "project-a" } },
        entryIds: [entryId],
        dryRun: true,
        reason: "user_request",
        idempotencyKey: "http-dryrun-key",
      });
      assert.equal(dryRun.status, 200);
      assert.equal(dryRun.json.writeOccurred, false);

      const moved = await postJson(baseUrl, "/v1/move_entry", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId,
        from: { kind: "project", project: { type: "id", id: "project-a" } },
        to: { kind: "user-global" },
        reason: "move to user scope",
        idempotencyKey: "http-maintenance-move",
      });
      assert.equal(moved.status, 200);
      assert.equal(moved.json.entry.target.kind, "user-global");
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
