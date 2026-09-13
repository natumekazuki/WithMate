import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { normalizeAuxiliarySession } from "../../src/auxiliary-session-state.js";
import { buildProviderAgentRuntimeAuthoritySnapshot } from "../../src-electron/provider-agent-runtime-binding.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary-session-service.js";
import { createMemoryV6HttpServer, getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory-v6-http-server.js";
import { callWithMateMemoryRuntime } from "../withmate-memory-runtime-client.js";

const API_SECRET = "api-secret";
const MCP_SECRET = "mcp-secret";

let server: ReturnType<typeof createMemoryV6HttpServer> | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// @test-value v2
// kind = "invariant"
// claim = "Actual Auxiliary runtime sessionのCharacter ownerがMemory public operationのactor authorityへ伝播する"
// oracle = { type = "contract", ref = "issue-710 Auxiliary Character Memory authority" }
// fault = "Auxiliary B/CがMain ownerまたは別Auxiliary ownerのMemory targetへ混線する"
// observable = "public search operationへ渡るprincipalのsessionId/characterId/allowedProjectIds"
// observation_boundary = "public-boundary"
// scope = "auxiliary-memory-authority"
// lifecycle = "permanent"
// @end-test-value
it("Auxiliary runtime sessionからMemory public actor authorityをowner別に解決する", async () => {
  const parent = buildNewSession({
    taskTitle: "main",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    provider: "codex",
    characterId: "character-main",
    character: "Main",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
  });
  const makeAux = (id: string, characterId: string) => normalizeAuxiliarySession({
    id,
    parentSessionId: parent.id,
    characterId,
    characterRuntimeSnapshot: {
      characterId,
      name: characterId,
      description: "",
      iconFilePath: "",
      theme: { main: "#6f8cff", sub: "#6fb8c7" },
      definitionMarkdown: "# Character",
      definitionSha256: `sha-${characterId}`,
      definitionByteSize: 11,
      snapshotAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const sessions = new Map([["aux-b", makeAux("aux-b", "character-b")!], ["aux-c", makeAux("aux-c", "character-c")!]]);
  const service = new AuxiliarySessionService({
    runProviderRuntimeOperationExclusive: async (operation) => operation(),
    resolveSessionLaunchSelection: async () => { throw new Error("unused"); },
    getParentSession: () => parent,
    getStorage: () => ({
      getAuxiliarySession: (id: string) => sessions.get(id) ?? null,
      getActiveAuxiliarySession: () => null,
      listAuxiliarySessions: () => [],
      listRunningActiveAuxiliarySessions: () => [],
      upsertAuxiliarySession: () => { throw new Error("unused"); },
      deleteAuxiliarySessionsForParent: () => undefined,
      deleteAuxiliarySessionsExceptParents: () => undefined,
      markRunningAuxiliarySessionsAsRecoverable: () => [],
    }),
    listActiveCharacters: () => [],
    createCharacterRuntimeSnapshot: () => null,
  });
  const registry = new AgentRuntimeBindingRegistry();
  const principalCalls: Array<{ sessionId: string; characterId: string; allowedProjectIds: string[] }> = [];
  server = createMemoryV6HttpServer({
    service: {
      search(principal: any) {
        principalCalls.push({ sessionId: principal.sessionId, characterId: principal.characterId, allowedProjectIds: principal.allowedProjectIds });
        return { schemaVersion: "withmate-memory-v1", items: [] };
      },
    } as any,
    apiSecret: API_SECRET,
    operatorApiSecret: "operator-secret",
    mcpApiSecret: MCP_SECRET,
    runtimeInstanceId: "runtime-authority",
    agentRuntimeBindingRegistry: registry,
    resolveActorSession: async (id) => {
      if (id === parent.id) {
        return { id: parent.id, providerId: parent.provider, characterId: parent.characterId, workspacePath: parent.workspacePath };
      }
      const session = await service.getAuxiliaryRuntimeSession(id);
      return session ? { id: session.id, providerId: session.provider, characterId: session.characterId, workspacePath: session.workspacePath } : null;
    },
    resolveKnownProjectByPath: (path) => path === parent.workspacePath ? { id: "project-workspace", displayName: "workspace" } : null,
  });
  await server.start();
  const address = server.address();
  assert.ok(address);
  for (const id of [parent.id, "aux-b", "aux-c"]) {
    const runtime = id === parent.id ? parent : await service.getAuxiliaryRuntimeSession(id);
    assert.ok(runtime);
    const authority = buildProviderAgentRuntimeAuthoritySnapshot({
      characterId: runtime.characterId,
      workspacePath: runtime.workspacePath,
      resolveCanonicalProjectId: () => "project-workspace",
    });
    assert.ok(authority);
    const binding = registry.issueOrReuse({ actorSessionId: id, providerId: runtime.provider, authoritySnapshot: authority, operationGrants: getMemoryV6AgentRuntimeOperations() });
    const response = await callWithMateMemoryRuntime({ api: { baseUrl: `http://127.0.0.1:${address.port}`, apiSecret: API_SECRET, runtimeGenerationId: "runtime-authority", runtimeInstanceId: "runtime-authority" }, credential: { adapter: "mcp", adapterSecret: MCP_SECRET } }, { method: "POST", path: "/v1/search", body: { schemaVersion: "withmate-memory-v1", query: "owner", targets: [{ kind: "project", project: { type: "id", id: "project-workspace" } }] } }, { signal: new AbortController().signal, bindingReference: binding.bindingReference });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(principalCalls, [
    { sessionId: parent.id, characterId: "character-main", allowedProjectIds: ["project-workspace"] },
    { sessionId: "aux-b", characterId: "character-b", allowedProjectIds: ["project-workspace"] },
    { sessionId: "aux-c", characterId: "character-c", allowedProjectIds: ["project-workspace"] },
  ]);
});
