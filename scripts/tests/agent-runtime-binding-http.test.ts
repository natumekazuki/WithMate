import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import {
  MEMORY_V6_ROUTE_BINDING_POLICIES,
  agentRuntimeOperationForMemoryRoute,
  createMemoryV6HttpServer,
  getMemoryV6AgentRuntimeOperations,
  type MemoryV6HttpServer,
} from "../../src-electron/memory-v6-http-server.js";
import type { CharacterContextApplicationService } from "../../src-electron/character-context-application-service.js";
import type { MemoryV6Service } from "../../src-electron/memory-v6-service.js";
import { callWithMateMemoryRuntime } from "../withmate-memory-runtime-client.js";

const API_SECRET = "api-secret";
const OPERATOR_SECRET = "operator-secret";
const MCP_SECRET = "mcp-secret";
const RUNTIME_ID = "runtime-a";

describe("Memory HTTP agent runtime binding policy", () => {
  let server: MemoryV6HttpServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("全WithMate-owned routeがrequired/optional/noneを宣言する", () => {
    assert.equal(Object.keys(MEMORY_V6_ROUTE_BINDING_POLICIES).length, 23);
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.character_context_get, "required");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.character_affect_appraise, "required");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.search, "optional");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.file_usage, "optional");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.character_memory_search, "optional");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.forget, "optional");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.move_entry, "optional");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.character_memory_correct, "optional");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.character_memory_forget, "optional");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.character_affect_reset, "none");
    assert.equal(MEMORY_V6_ROUTE_BINDING_POLICIES.character_context_metrics, "none");
  });

  it("required routeはbinding前にdispatchせず、actor Sessionをserver側で正規化する", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const calls: unknown[] = [];
    const characterContextService = {
      async getContext(body: unknown) {
        calls.push(body);
        const request = body as { characterId: string; sessionId: string };
        return {
          schemaVersion: "withmate-character-context-v1",
          characterId: request.characterId,
          sessionId: request.sessionId,
        };
      },
    } as unknown as CharacterContextApplicationService;
    const runtime = await startServer({ registry, characterContextService });

    const withoutBinding = await runtime.call("/v1/character_context/get", {
      schemaVersion: "withmate-character-context-v1",
      characterId: "character-a",
      sessionId: "spoofed",
    });
    assert.equal(withoutBinding.status, 403);
    assert.equal((withoutBinding.value as any).error.details.bindingFailure, "SESSION_BINDING_REQUIRED");
    assert.equal(calls.length, 0);

    const resolved = await runtime.call("/v1/character_context/get", {
      schemaVersion: "withmate-character-context-v1",
      characterId: "character-a",
      sessionId: "spoofed",
    }, binding.bindingReference);
    assert.equal(resolved.status, 200);
    assert.equal((resolved.value as any).sessionId, "session-a");
    assert.equal((calls[0] as any).sessionId, "session-a");

    const otherTarget = await runtime.call("/v1/character_context/get", {
      schemaVersion: "withmate-character-context-v1",
      characterId: "character-b",
    }, binding.bindingReference);
    assert.equal(otherTarget.status, 403);
    assert.equal(calls.length, 1);
  });

  it("optional Memoryは明示targetを維持し、bindingがあればsource principalだけをactor化する", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const calls: Array<{ principal: any; body: any }> = [];
    const service = {
      search(principal: unknown, body: unknown) {
        calls.push({ principal, body });
        return { schemaVersion: "withmate-memory-v1", items: [] };
      },
    } as unknown as MemoryV6Service;
    const runtime = await startServer({ registry, service });
    const body = {
      schemaVersion: "withmate-memory-v1",
      targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-target" } }],
      query: "runtime binding",
    };

    assert.equal((await runtime.call("/v1/search", body)).status, 200);
    assert.equal(calls[0]?.principal.type, "local_user");
    assert.deepEqual(calls[0]?.body, body);

    assert.equal((await runtime.call("/v1/search", body, binding.bindingReference)).status, 200);
    assert.equal(calls[1]?.principal.type, "session_binding");
    assert.equal(calls[1]?.principal.sessionId, "session-a");
    assert.equal(calls[1]?.principal.characterId, "character-a");
    assert.deepEqual(calls[1]?.body, body);

    const invalid = await runtime.call("/v1/search", body, "unknown-reference");
    assert.equal(invalid.status, 403);
    assert.equal(JSON.stringify(invalid.value).includes("unknown-reference"), false);
    assert.equal(calls.length, 2);
  });

  it("agent-facing Memory mutationはbinding principalを使用し、bindingなしならlocal userを維持する", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const calls: Array<{ principal: any; body: any }> = [];
    const service = {
      forget(principal: unknown, body: unknown) {
        calls.push({ principal, body });
        return { schemaVersion: "withmate-memory-v1", results: [] };
      },
    } as unknown as MemoryV6Service;
    const runtime = await startServer({ registry, service });
    const body = {
      schemaVersion: "withmate-memory-v1",
      target: { owner: "user", scope: "global" },
      reason: "binding policy test",
      idempotencyKey: "binding-none-route",
    };

    assert.equal((await runtime.call("/v1/forget", body)).status, 200);
    assert.equal(calls[0]?.principal.type, "local_user");
    assert.deepEqual(calls[0]?.body, body);

    assert.equal((await runtime.call("/v1/forget", body, binding.bindingReference)).status, 200);
    assert.equal(calls[1]?.principal.type, "session_binding");
    assert.equal(calls[1]?.principal.sessionId, "session-a");
    assert.equal(calls[1]?.principal.characterId, "character-a");
  });

  it("Character correct/forgetはunbound MCPをconversation authorityへ昇格させない", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const calls: Array<{ body: any; principal: any }> = [];
    const characterContextService = {
      async correctMemory(body: unknown, _transport: unknown, principal: unknown) {
        calls.push({ body, principal });
        return { schemaVersion: "withmate-character-context-v1", operation: "correct" };
      },
      async forgetMemory(body: unknown, _transport: unknown, principal: unknown) {
        calls.push({ body, principal });
        return { schemaVersion: "withmate-character-context-v1", operation: "forget" };
      },
    } as unknown as CharacterContextApplicationService;
    const runtime = await startServer({ registry, characterContextService });
    const correctBody = {
      schemaVersion: "withmate-character-context-v1",
      characterId: "character-a",
      entryId: "memory-a",
      reason: "corrected fact",
      idempotencyKey: "correct-a",
      replacement: { observedFact: "corrected" },
    };

    const unboundCorrect = await runtime.call("/v1/character_memory/correct", correctBody);
    assert.equal(unboundCorrect.status, 403);
    assert.equal((unboundCorrect.value as any).error.code, "authority_denied");
    const unboundForget = await runtime.call("/v1/character_memory/forget", {
      schemaVersion: "withmate-character-context-v1",
      characterId: "character-a",
      entryId: "memory-a",
      reason: "user_request",
      idempotencyKey: "forget-a",
    });
    assert.equal(unboundForget.status, 403);
    assert.equal(calls.length, 0);

    const boundCorrect = await runtime.call(
      "/v1/character_memory/correct",
      correctBody,
      binding.bindingReference,
    );
    assert.equal(boundCorrect.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.principal.type, "session_binding");
    assert.equal(calls[0]?.body.authority.kind, "conversation");
  });

  it("optional routeでも提示済みの空白bindingを未提示へfallbackしない", async () => {
    const calls: unknown[] = [];
    const service = {
      search() {
        calls.push(true);
        return { schemaVersion: "withmate-memory-v1", items: [] };
      },
    } as unknown as MemoryV6Service;
    const runtime = await startServer({ registry: new AgentRuntimeBindingRegistry(), service });

    const response = await runtime.call("/v1/search", {
      schemaVersion: "withmate-memory-v1",
      targets: [{ owner: "user", scope: "global" }],
      query: "binding",
    }, "   ");

    assert.equal(response.status, 403);
    assert.equal((response.value as any).error.code, "MEMORY_FORBIDDEN");
    assert.equal(calls.length, 0);
  });

  it("none routeはbinding付きprovider CLIをoperatorへ昇格させずdispatch前に拒否する", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const calls: unknown[] = [];
    const characterContextService = {
      async resetAffect(body: unknown) {
        calls.push(body);
        return { schemaVersion: "withmate-character-context-v1", resetId: "reset-a" };
      },
    } as unknown as CharacterContextApplicationService;
    const runtime = await startServer({ registry, characterContextService });
    const body = {
      schemaVersion: "withmate-character-context-v1",
      characterId: "character-b",
      sessionId: "session-b",
      layer: "session",
      authority: { kind: "operator", reason: "test" },
      reason: "test",
      resetAt: "2026-08-15T00:00:00.000Z",
      idempotencyKey: "none-route-binding",
    };

    const bound = await runtime.callOperator(
      "/v1/character_affect/reset",
      body,
      binding.bindingReference,
    );
    assert.equal(bound.status, 403);
    assert.equal((bound.value as any).error.details.bindingFailure, "SESSION_BINDING_FORBIDDEN");
    assert.equal(calls.length, 0);

    const operator = await runtime.callOperator("/v1/character_affect/reset", body);
    assert.equal(operator.status, 200);
    assert.equal(calls.length, 1);
  });

  async function startServer(input: {
    registry: AgentRuntimeBindingRegistry;
    service?: MemoryV6Service;
    characterContextService?: CharacterContextApplicationService;
  }): Promise<{
    call(path: string, body: unknown, bindingReference?: string): ReturnType<typeof callWithMateMemoryRuntime>;
    callOperator(path: string, body: unknown, bindingReference?: string): ReturnType<typeof callWithMateMemoryRuntime>;
  }> {
    server = createMemoryV6HttpServer({
      service: input.service ?? ({} as MemoryV6Service),
      characterContextService: input.characterContextService,
      apiSecret: API_SECRET,
      operatorApiSecret: OPERATOR_SECRET,
      mcpApiSecret: MCP_SECRET,
      runtimeInstanceId: RUNTIME_ID,
      agentRuntimeBindingRegistry: input.registry,
      resolveActorSession: (sessionId) => sessionId === "session-a"
        ? { id: "session-a", providerId: "codex", characterId: "character-a" }
        : null,
    });
    await server.start();
    const address = server.address();
    assert.ok(address);
    const connection = {
      api: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiSecret: API_SECRET,
        runtimeGenerationId: RUNTIME_ID,
        runtimeInstanceId: RUNTIME_ID,
      },
      credential: { adapter: "mcp" as const, adapterSecret: MCP_SECRET },
    };
    return {
      call: (path, body, bindingReference) => callWithMateMemoryRuntime(
        connection,
        { method: "POST", path, body },
        { signal: new AbortController().signal, bindingReference },
      ),
      callOperator: (path, body, bindingReference) => callWithMateMemoryRuntime(
        {
          ...connection,
          credential: { adapter: "cli" as const, adapterSecret: OPERATOR_SECRET },
        },
        { method: "POST", path, body },
        { signal: new AbortController().signal, bindingReference },
      ),
    };
  }
});

it("policy operation名はgrant detailをpublic responseへ投影しないstable route keyである", () => {
  assert.equal(
    agentRuntimeOperationForMemoryRoute("character_context_get"),
    "memory.route.character_context_get",
  );
});
