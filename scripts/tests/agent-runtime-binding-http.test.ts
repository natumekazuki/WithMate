import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/provider-agent-runtime-turn-coordinator.js";
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

  // @test-value v1
  // kind = "security"
  // claim = "Character contextはbinding由来のactor identityだけを内部requestへ設定しpublic responseへ投影しない"
  // oracle = { type = "adr", ref = "ADR-024 Character tool input and context projection" }
  // failure_mode = "caller指定identityがdispatchされる、またはresolved Session/Character IDがresponseへ露出する"
  // scope = "memory-http-character-context-binding"
  // lifecycle = "permanent"
  // @end-test-value
  it("required routeはbinding前にdispatchせず、actor Sessionをserver側で正規化する", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { userId: "local-user", characterId: "character-a", allowedProjectIds: ["project-a"] },
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const calls: unknown[] = [];
    const characterContextService = {
      async getContext(body: unknown) {
        calls.push(body);
        const request = body as { characterId: string; sessionId: string };
        return { schemaVersion: "withmate-character-context-v1", baseline: {}, affect: {}, memory: {} };
      },
    } as unknown as CharacterContextApplicationService;
    const runtime = await startServer({ registry, characterContextService });

    const withoutBinding = await runtime.call("/v1/character_context/get", {
      schemaVersion: "withmate-character-context-v1",
    });
    assert.equal(withoutBinding.status, 403);
    assert.equal((withoutBinding.value as any).error.details.bindingFailure, "SESSION_BINDING_REQUIRED");
    assert.equal(calls.length, 0);

    const resolved = await runtime.call("/v1/character_context/get", {
      schemaVersion: "withmate-character-context-v1",
    }, binding.bindingReference);
    assert.equal(resolved.status, 200);
    assert.equal("sessionId" in (resolved.value as any), false);
    assert.equal((calls[0] as any).sessionId, "session-a");
    assert.equal((calls[0] as any).characterId, "character-a");

    const otherTarget = await runtime.call("/v1/character_context/get", {
      schemaVersion: "withmate-character-context-v1",
      characterId: "character-b",
    }, binding.bindingReference);
    assert.equal(otherTarget.status, 422);
    assert.equal(calls.length, 1);
  });

  // @test-value v1
  // kind = "security"
  // claim = "agent-facing Memory readはbinding必須でactor-relative Project targetを許可済みcanonical IDへ解決する"
  // oracle = { type = "adr", ref = "ADR-024 actor-relative Memory target" }
  // failure_mode = "unbound requestがlocal-userへdowngradeする、またはcaller targetが未検証でapplicationへ到達する"
  // scope = "memory-http-general-read-binding"
  // lifecycle = "permanent"
  // @end-test-value
  it("agent-facing Memory readはbindingを必須にしてactor-relative targetをcanonicalizeする", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { userId: "local-user", characterId: "character-a", allowedProjectIds: ["project-a"] },
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const calls: Array<{ principal: any; body: any }> = [];
    const service = {
      search(principal: unknown, body: unknown) {
        calls.push({ principal, body });
        return {
          schemaVersion: "withmate-memory-v1",
          items: [{
            id: "entry-a",
            owner: { type: "project", id: "project-a" },
            scope: { type: "project", id: "project-a" },
            title: "Project entry",
          }],
        };
      },
      listTargets(principal: unknown, body: unknown) {
        calls.push({ principal, body });
        return {
          schemaVersion: "withmate-memory-v1",
          items: [
            {
              target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
              owner: "project",
              scope: "project",
              project: { id: "project-a", displayName: "Project A", path: "C:/project-a" },
              entryCount: 1,
              tagCount: 0,
              lastUpdatedAt: null,
            },
            {
              target: { owner: "project", scope: "project", project: { type: "id", id: "project-b" } },
              owner: "project",
              scope: "project",
              project: { id: "project-b", displayName: "Project B", path: "C:/project-b" },
              entryCount: 2,
              tagCount: 1,
              lastUpdatedAt: null,
            },
          ],
        };
      },
    } as unknown as MemoryV6Service;
    const runtime = await startServer({ registry, service });
    const body = {
      schemaVersion: "withmate-memory-v1",
      targets: [{ kind: "project", project: { type: "id", id: "project-a" } }],
      query: "runtime binding",
    };

    assert.equal((await runtime.call("/v1/search", body)).status, 401);
    assert.equal(calls.length, 0);

    const bound = await runtime.call("/v1/search", body, binding.bindingReference);
    assert.equal(bound.status, 200);
    assert.equal(calls[0]?.principal.type, "session_binding");
    assert.equal(calls[0]?.principal.sessionId, "session-a");
    assert.equal(calls[0]?.principal.characterId, "character-a");
    assert.deepEqual(calls[0]?.body.targets, [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }]);
    assert.deepEqual((bound.value as any).items[0].target, {
      kind: "project",
      project: { type: "id", id: "project-a" },
    });
    assert.equal("owner" in (bound.value as any).items[0], false);
    assert.equal("scope" in (bound.value as any).items[0], false);

    const inventory = await runtime.call("/v1/list_targets", {
      schemaVersion: "withmate-memory-v1",
      filter: { kind: "project" },
    }, binding.bindingReference);
    assert.equal(inventory.status, 200);
    assert.deepEqual((inventory.value as any).items, [{
      target: { kind: "project", project: { type: "id", id: "project-a" } },
      entryCount: 1,
      tagCount: 0,
      lastUpdatedAt: null,
    }]);

    const invalid = await runtime.call("/v1/search", body, "unknown-reference");
    assert.equal(invalid.status, 403);
    assert.equal(JSON.stringify(invalid.value).includes("unknown-reference"), false);
    assert.equal(calls.length, 2);
  });

  // @test-value v1
  // kind = "security"
  // claim = "Character Memory searchのproject scopeはbinding許可Projectへcanonicalizeされ、別Projectはdispatch前に拒否される"
  // oracle = { type = "adr", ref = "ADR-024 Character tool input and actor-relative scope" }
  // failure_mode = "caller project pathまたは未許可Projectがactor Characterとの複合scopeへ到達する"
  // scope = "memory-http-character-search-project-authority"
  // lifecycle = "permanent"
  // @end-test-value
  it("Character Memory searchはactor Characterと許可Projectだけを使う", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { userId: "local-user", characterId: "character-a", allowedProjectIds: ["project-a"] },
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const calls: unknown[] = [];
    const characterContextService = {
      async searchMemory(body: unknown) {
        calls.push(body);
        return {
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          scope: { scope: "project", project: { type: "id", id: "project-a" } },
          items: [],
          sourceVersion: null,
        };
      },
    } as unknown as CharacterContextApplicationService;
    const runtime = await startServer({ registry, characterContextService });

    const allowed = await runtime.call("/v1/character_memory/search", {
      schemaVersion: "withmate-character-context-v1",
      query: "project context",
      scope: { scope: "project", project: { type: "path", path: "C:/project-a" } },
    }, binding.bindingReference);
    assert.equal(allowed.status, 200);
    assert.deepEqual((calls[0] as any).scope, {
      scope: "project",
      project: { type: "id", id: "project-a" },
    });
    assert.equal((calls[0] as any).characterId, "character-a");

    const denied = await runtime.call("/v1/character_memory/search", {
      schemaVersion: "withmate-character-context-v1",
      query: "other project",
      scope: { scope: "project", project: { type: "id", id: "project-b" } },
    }, binding.bindingReference);
    assert.equal(denied.status, 422);
    assert.equal((denied.value as any).error.field, "scope");
    assert.equal(calls.length, 1);
  });

  // @test-value v1
  // kind = "security"
  // claim = "agent-facing Memory mutationはbindingとcurrent provider turn capabilityの両方を要求する"
  // oracle = { type = "adr", ref = "ADR-024 provider turn capability" }
  // failure_mode = "unboundまたはstale turnのmutationがapplicationへ到達する"
  // scope = "memory-http-general-mutation-turn"
  // lifecycle = "permanent"
  // @end-test-value
  it("agent-facing Memory mutationはbindingとcurrent turn capabilityを要求する", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { userId: "local-user", characterId: "character-a", allowedProjectIds: ["project-a"] },
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
      target: { kind: "user-global" },
      reason: "binding policy test",
      idempotencyKey: "binding-none-route",
    };

    assert.equal((await runtime.call("/v1/forget", body)).status, 401);
    assert.equal(calls.length, 0);

    assert.equal((await runtime.call("/v1/forget", body, binding.bindingReference)).status, 200);
    assert.equal(calls[0]?.principal.type, "session_binding");
    assert.equal(calls[0]?.principal.sessionId, "session-a");
    assert.equal(calls[0]?.principal.characterId, "character-a");

    runtime.expireTurn();
    const stale = await runtime.call("/v1/forget", body, binding.bindingReference);
    assert.equal(stale.status, 403);
    assert.equal((stale.value as any).error.effect, "none");
    assert.equal(calls.length, 1);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "authority外responseのprojection failureはdry-runをeffect none、writeをeffect unknownとして区別する"
  // oracle = { type = "adr", ref = "ADR-024 failure timing and effect certainty" }
  // failure_mode = "dispatch済みwriteのeffectをnoneと誤認する、または非書込dry-runをunknownとして不要なreconcile対象にする"
  // scope = "memory-http-response-projection-effect"
  // lifecycle = "permanent"
  // @end-test-value
  it("agent response projection failureはrequestのwrite可能性をeffectへ反映する", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { userId: "local-user", characterId: "character-a", allowedProjectIds: ["project-a"] },
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const service = {
      forget() {
        return {
          schemaVersion: "withmate-memory-v1",
          results: [{
            entry: {
              owner: { type: "project", id: "project-b" },
              scope: { type: "project", id: "project-b" },
            },
          }],
        };
      },
    } as unknown as MemoryV6Service;
    const runtime = await startServer({ registry, service });
    const request = {
      schemaVersion: "withmate-memory-v1",
      target: { kind: "user-global" },
      reason: "projection effect test",
      idempotencyKey: "projection-effect",
    };

    const dryRun = await runtime.call("/v1/forget", { ...request, dryRun: true }, binding.bindingReference);
    assert.equal(dryRun.status, 403);
    assert.equal((dryRun.value as any).error.effect, "none");

    const write = await runtime.call("/v1/forget", request, binding.bindingReference);
    assert.equal(write.status, 403);
    assert.equal((write.value as any).error.effect, "unknown");
  });

  // @test-value v1
  // kind = "security"
  // claim = "Character mutationはbound actorとcurrent turnだけをconversation authorityへ昇格する"
  // oracle = { type = "adr", ref = "ADR-024 Character mutation authority" }
  // failure_mode = "unbound MCPまたはcaller identityがCharacter correction authorityを取得する"
  // scope = "memory-http-character-mutation-turn"
  // lifecycle = "permanent"
  // @end-test-value
  it("Character correct/forgetはunbound MCPをconversation authorityへ昇格させない", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { userId: "local-user", characterId: "character-a", allowedProjectIds: ["project-a"] },
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

  // @test-value v1
  // kind = "security"
  // claim = "agent CLI fallbackはMCP credential、binding、fallback markerを組み合わせてもMCP-equivalent routeだけを実行する"
  // oracle = { type = "adr", ref = "ADR-024 operator CLI and agent-bound CLI fallback" }
  // failure_mode = "fallbackがoperator credentialを使用する、operator-only routeへ昇格する、またはbindingなしでdispatchする"
  // scope = "memory-runtime-agent-cli-fallback"
  // lifecycle = "permanent"
  // @end-test-value
  it("agent CLI fallbackはMCP credentialとbindingでMCP allowlistだけを使う", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { userId: "local-user", characterId: "character-a", allowedProjectIds: ["project-a"] },
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const calls: unknown[] = [];
    const service = {
      search() {
        calls.push(true);
        return { schemaVersion: "withmate-memory-v1", items: [] };
      },
    } as unknown as MemoryV6Service;
    const runtime = await startServer({ registry, service });
    const body = {
      schemaVersion: "withmate-memory-v1",
      targets: [{ kind: "user-global" }],
      query: "fallback",
    };

    const allowed = await runtime.callFallback("/v1/search", body, binding.bindingReference);
    assert.equal(allowed.status, 200);
    assert.equal(calls.length, 1);

    const denied = await runtime.callFallback("/v1/audit", {
      schemaVersion: "withmate-memory-v1",
      allTargets: true,
    }, binding.bindingReference);
    assert.equal(denied.status, 403);
    assert.equal(calls.length, 1);

    await assert.rejects(
      runtime.callOperatorFallback("/v1/search", body, binding.bindingReference),
      /requires the MCP runtime credential/,
    );
    assert.equal(calls.length, 1);
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
    callFallback(path: string, body: unknown, bindingReference?: string): ReturnType<typeof callWithMateMemoryRuntime>;
    callOperator(path: string, body: unknown, bindingReference?: string): ReturnType<typeof callWithMateMemoryRuntime>;
    callOperatorFallback(path: string, body: unknown, bindingReference?: string): ReturnType<typeof callWithMateMemoryRuntime>;
    expireTurn(): void;
  }> {
    const turns = new ProviderAgentRuntimeTurnCoordinator();
    const turn = turns.begin({ actorSessionId: "session-a", providerId: "codex" });
    server = createMemoryV6HttpServer({
      service: input.service ?? ({} as MemoryV6Service),
      characterContextService: input.characterContextService,
      apiSecret: API_SECRET,
      operatorApiSecret: OPERATOR_SECRET,
      mcpApiSecret: MCP_SECRET,
      runtimeInstanceId: RUNTIME_ID,
      agentRuntimeBindingRegistry: input.registry,
      providerAgentRuntimeTurns: turns,
      resolveActorSession: (sessionId) => sessionId === "session-a"
        ? { id: "session-a", providerId: "codex", characterId: "character-a" }
        : null,
      resolveProjectById: (projectId) => projectId === "project-a"
        ? { id: "project-a", displayName: "Project A" }
        : null,
      resolveKnownProjectByPath: (projectPath) => projectPath === "C:/project-a"
        ? { id: "project-a", displayName: "Project A" }
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
        { signal: new AbortController().signal, bindingReference, turnCapability: turn.capability },
      ),
      callFallback: (path, body, bindingReference) => callWithMateMemoryRuntime(
        connection,
        { method: "POST", path, body, fallbackFrom: "mcp" },
        { signal: new AbortController().signal, bindingReference, turnCapability: turn.capability },
      ),
      callOperator: (path, body, bindingReference) => callWithMateMemoryRuntime(
        {
          ...connection,
          credential: { adapter: "cli" as const, adapterSecret: OPERATOR_SECRET },
        },
        { method: "POST", path, body },
        { signal: new AbortController().signal, bindingReference },
      ),
      callOperatorFallback: (path, body, bindingReference) => callWithMateMemoryRuntime(
        {
          ...connection,
          credential: { adapter: "cli" as const, adapterSecret: OPERATOR_SECRET },
        },
        { method: "POST", path, body, fallbackFrom: "mcp" },
        { signal: new AbortController().signal, bindingReference, turnCapability: turn.capability },
      ),
      expireTurn: () => turns.end(turn),
    };
  }
});

it("policy operation名はgrant detailをpublic responseへ投影しないstable route keyである", () => {
  assert.equal(
    agentRuntimeOperationForMemoryRoute("character_context_get"),
    "memory.route.character_context_get",
  );
});
