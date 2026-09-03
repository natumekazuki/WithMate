import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AffectEventInput } from "../../src/character-affect/affect-contract.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import { CharacterAffectTurnSettlementStorage } from "../../src-electron/character-affect-turn-settlement-storage.js";
import { settleCharacterAffectTurnWithRetry } from "../../src-electron/character-affect-turn-settler.js";
import { getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory-v6-http-server.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/provider-agent-runtime-turn-coordinator.js";
import { startMemoryV6RuntimeApi } from "../../src-electron/memory-v6-runtime.js";
import { runWithMateMemoryCli } from "../withmate-memory.js";
import { createWithMateMemoryMcpServer } from "../withmate-memory-mcp.js";

function outputBuffer() {
  let value = "";
  return {
    stream: { write(chunk: string | Uint8Array) { value += chunk.toString(); return true; } },
    json() { return JSON.parse(value.trim()) as Record<string, any>; },
  };
}

describe("Character context CLI / MCP integration", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "bound MCPはcaller identityなしでactor Sessionを解決し、CLI/MCPのaffect event列とpost-turn appraisalを同じstate、scope、versionへ収束させる"
  // oracle = { type = "contract", ref = "Character affect settlement and ADR-023" }
  // failure_mode = "MCPがcaller identityを要求する、またはruntime selector導入でCLIとMCPが別instanceへ分岐して同一Sessionのstateかversionが不一致になる"
  // scope = "character-context-cli-mcp-runtime-binding"
  // lifecycle = "permanent"
  // @end-test-value
  it("owner-bound runtimeで通常Sessionの即時event列とpost-turn appraisalが同じstate、scope、versionへ収束する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-character-runtime-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-character-discovery-"));
    const bindingRegistry = new AgentRuntimeBindingRegistry();
    const turns = new ProviderAgentRuntimeTurnCoordinator();
    const runtime = await startMemoryV6RuntimeApi({
      userDataPath,
      applicationInstanceId: "11111111-1111-4111-8111-111111111111",
      buildChannel: "development",
      registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
      runtimeDirectoryPath,
      now: () => new Date("2026-08-09T09:00:00.000Z"),
      listCharacters: () => [{
        id: "character-a",
        name: "A",
        description: "Test Character",
        iconFilePath: "",
        theme: { main: "#000000", sub: "#ffffff" },
        state: "active",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        archivedAt: null,
      }],
      resolveCharacterRuntimeSnapshot: (characterId) => characterId === "character-a" ? {
        characterId,
        name: "A",
        description: "Test Character",
        iconFilePath: "",
        theme: { main: "#000000", sub: "#ffffff" },
        definitionMarkdown: "Cheerful Character.",
        definitionSha256: "definition-hash",
        definitionByteSize: 18,
        snapshotAt: "2026-08-09T00:00:00.000Z",
      } : null,
      agentRuntimeBindingRegistry: bindingRegistry,
      providerAgentRuntimeTurns: turns,
      resolveActorSession: (sessionId) => sessionId === "session-a"
        ? { id: "session-a", providerId: "codex", characterId: "character-a" }
        : null,
    });
    const db = new DatabaseSync(runtime.dbPath);
    db.exec("PRAGMA foreign_keys = ON;");
    db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES ('character-a', 'A', ?, ?)")
      .run("2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z");
    db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        character_id, character_snapshot_json, created_at, updated_at, last_active_at
      ) VALUES ('session-a', 'A', 'active', 'codex', 1, 'gpt-5', 'on-request', 'character-a', '{}', ?, ?, ?)
    `).run("2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z");
    db.close();

    const binding = bindingRegistry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { userId: "local-user", characterId: "character-a", allowedProjectIds: [] },
      operationGrants: getMemoryV6AgentRuntimeOperations(),
    });
    const turn = turns.begin({ actorSessionId: "session-a", providerId: "codex" });
    const operatorCliEnv = {
      WITHMATE_MEMORY_DISCOVERY_FILE: runtime.discoveryFilePath,
    };
    const mcpEnv = {
      WITHMATE_MEMORY_DISCOVERY_FILE: runtime.mcpDiscoveryFilePath,
      WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
      WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
      WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability,
      WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: runtime.applicationInstanceId,
      WITHMATE_MEMORY_RUNTIME_GENERATION_ID: runtime.runtimeGenerationId,
    };
    const runCli = (args: readonly string[], deps: Parameters<typeof runWithMateMemoryCli>[1] = {}) => runWithMateMemoryCli(args, {
      ...deps,
      registryRootDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: mcpEnv,
      registryRootDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
    });
    const client = new Client({ name: "withmate-cli-mcp-integration", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const beforeOutput = outputBuffer();
      const beforeExitCode = await runCli([
        "context-get",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
        }),
      ], { env: operatorCliEnv, stdout: beforeOutput.stream, stderr: outputBuffer().stream });
      assert.equal(beforeExitCode, 0, JSON.stringify(beforeOutput.json()));
      const before = beforeOutput.json();

      const metricsOutput = outputBuffer();
      const metricsExitCode = await runCli([
        "character-metrics",
      ], { env: operatorCliEnv, stdout: metricsOutput.stream, stderr: outputBuffer().stream });
      assert.equal(metricsExitCode, 0, JSON.stringify(metricsOutput.json()));
      assert.equal(metricsOutput.json().metrics.fallbacks["mcp->cli"] ?? 0, 0);

      const rejectedCliOutput = outputBuffer();
      const rejectedCliExitCode = await runCli([
        "affect-appraise",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
          expectedVersion: before.affect.version,
          authority: { kind: "operator", reason: "Unknown family integration check." },
          candidates: [{
            schemaVersion: "withmate-affect-v1",
            characterId: "character-a",
            userId: "local-user",
            sessionId: "session-a",
            layer: "session",
            targetType: "task",
            targetId: "unknown-family",
            family: "unknown",
            value: { label: "free label", valence: 0 },
            intensity: 0.5,
            reason: "Unknown family must be rejected.",
            evidence: "CLI validation integration.",
            occurredAt: "2026-08-09T03:00:00.000Z",
            idempotencyKey: "cli-unknown-family",
          }],
        }),
      ], { env: operatorCliEnv, stdout: rejectedCliOutput.stream, stderr: outputBuffer().stream });
      assert.equal(rejectedCliExitCode, 0, JSON.stringify(rejectedCliOutput.json()));
      assert.equal(rejectedCliOutput.json().saved.length, 0);
      assert.equal(rejectedCliOutput.json().rejected[0].code, "invalid_input");

      const frustrationRequest = {
        name: "character_affect.appraise",
        arguments: {
          expectedVersion: before.affect.version,
          candidates: [{
            schemaVersion: "withmate-affect-v1",
            layer: "session",
            targetType: "bug",
            targetId: "mcp-integration",
            family: "frustration",
            value: { label: "frustration", valence: -0.6 },
            intensity: 0.7,
            reason: "The integration initially failed.",
            evidence: "The bound MCP request observed the failure.",
            occurredAt: "2026-08-09T03:00:00.000Z",
            idempotencyKey: "mcp-affect-frustration-1",
            memoryEpisode: {
              title: "Integration failure observed",
              preview: "The integration initially failed.",
              body: "The bound MCP appraisal recorded the integration failure.",
              salience: 0.7,
              motif: "integration-recovery",
            },
          }],
        },
      } as const;
      const frustration = await client.callTool(frustrationRequest);
      assert.equal(frustration.isError, undefined, JSON.stringify(frustration));
      const frustrationState = frustration.structuredContent as Record<string, any>;

      // The first response may have been lost at the client. Reconcile the unchanged request and key.
      const frustrationReplay = await client.callTool(frustrationRequest);
      assert.equal(frustrationReplay.isError, undefined, JSON.stringify(frustrationReplay));
      const replayState = frustrationReplay.structuredContent as Record<string, any>;
      assert.equal(replayState.saved[0].replayed, true);
      assert.equal(replayState.saved[0].eventId, frustrationState.saved[0].eventId);
      assert.equal(replayState.saved[0].memoryEntryId, frustrationState.saved[0].memoryEntryId);
      assert.equal(replayState.version, frustrationState.version);

      const linkedEpisodeReadBack = await client.callTool({
        name: "character_memory.search",
        arguments: {
          query: "Integration failure observed",
          scope: { scope: "character" },
          limit: 5,
        },
      });
      assert.equal(linkedEpisodeReadBack.isError, undefined, JSON.stringify(linkedEpisodeReadBack));
      const linkedEpisodes = (linkedEpisodeReadBack.structuredContent as Record<string, any>).items;
      assert.equal(linkedEpisodes.length, 1);
      assert.equal(linkedEpisodes[0].id, frustrationState.saved[0].memoryEntryId);

      const relief = await client.callTool({
        name: "character_affect.appraise",
        arguments: {
          expectedVersion: replayState.version,
          candidates: [{
            schemaVersion: "withmate-affect-v1",
            layer: "session",
            targetType: "bug",
            targetId: "mcp-integration",
            family: "relief",
            value: { label: "relief", valence: 0.7 },
            intensity: 0.8,
            reason: "The integration recovered.",
            evidence: "The bound MCP request completed successfully.",
            occurredAt: "2026-08-09T03:01:00.000Z",
            idempotencyKey: "mcp-affect-relief-1",
          }],
        },
      });
      assert.equal(relief.isError, undefined, JSON.stringify(relief));
      const reliefState = relief.structuredContent as Record<string, any>;

      const laterFrustration = await client.callTool({
        name: "character_affect.appraise",
        arguments: {
          expectedVersion: reliefState.version,
          candidates: [{
            schemaVersion: "withmate-affect-v1",
            layer: "session",
            targetType: "bug",
            targetId: "mcp-integration",
            family: "frustration",
            value: { label: "frustration", valence: -0.4 },
            intensity: 0.5,
            reason: "A later integration step failed.",
            evidence: "A distinct later failure occurred.",
            occurredAt: "2026-08-09T03:02:00.000Z",
            idempotencyKey: "mcp-affect-frustration-2",
          }],
        },
      });
      assert.equal(laterFrustration.isError, undefined, JSON.stringify(laterFrustration));
      const laterFrustrationState = laterFrustration.structuredContent as Record<string, any>;

      const settlementStorage = new CharacterAffectTurnSettlementStorage(runtime.dbPath);
      const correlationId = "turn:session-a:audit:after-immediate-appraisal";
      try {
        settlementStorage.enqueue({
          correlationId,
          characterId: "character-a",
          sessionId: "session-a",
          userMessage: "Run the integration.",
          assistantMessage: "The integration recovered.",
          assistantMessageIndex: 1,
          occurredAt: "2026-08-09T03:03:00.000Z",
        });
        const settlement = await settleCharacterAffectTurnWithRetry({
          correlationId,
          getPending: () => settlementStorage.getPending(correlationId),
          getContext: () => runtime.characterContextService.getContext({
            schemaVersion: "withmate-character-context-v1",
            characterId: "character-a",
            sessionId: "session-a",
          }, "lifecycle"),
          async evaluate(_context, idempotencyPrefix): Promise<AffectEventInput[]> {
            return [{
              schemaVersion: "withmate-affect-v1",
              characterId: "character-a",
              userId: "local-user",
              sessionId: "session-a",
              layer: "session",
              targetType: "task",
              targetId: "mcp-post-turn",
              family: "relief",
              value: { label: "relief", valence: 0.5 },
              intensity: 0.4,
              reason: "The completed turn was appraised after immediate events.",
              evidence: "Post-turn settlement used the latest context.",
              occurredAt: "2026-08-09T03:03:00.000Z",
              idempotencyKey: `${idempotencyPrefix}:0`,
            }];
          },
          persistEvaluation(input) {
            settlementStorage.saveEvaluation({ correlationId, ...input });
          },
          appraise: (expectedVersion, candidates) => runtime.characterContextService.appraise({
            schemaVersion: "withmate-character-context-v1",
            characterId: "character-a",
            sessionId: "session-a",
            expectedVersion,
            authority: { kind: "conversation" },
            candidates,
          }, "lifecycle"),
          recordAppraisalFailure: (input) => settlementStorage.recordAppraisalFailure({ correlationId, ...input }),
          markSettled: () => settlementStorage.markSettled(correlationId),
        });
        assert.equal(settlement.status, "settled", JSON.stringify(settlement));
        assert.equal(settlementStorage.getPending(correlationId), null);
      } finally {
        settlementStorage.close();
      }

      const inspectOutput = outputBuffer();
      assert.equal(await runCli([
        "affect-inspect",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
          authority: { kind: "operator", reason: "Integration inspection." },
        }),
      ], { env: operatorCliEnv, stdout: inspectOutput.stream, stderr: outputBuffer().stream }), 0);
      const inspection = inspectOutput.json();
      assert.notEqual(inspection.version.version, laterFrustrationState.version);
      assert.equal(inspection.events.length, 4);
      assert.equal(inspection.events.filter((event: Record<string, any>) => (
        event.targetId === "mcp-integration" && event.family === "frustration"
      )).length, 2);
      assert.equal(inspection.events.some((event: Record<string, any>) => (
        event.targetId === "mcp-integration" && event.family === "relief"
      )), true);
      assert.equal(inspection.events.some((event: Record<string, any>) => (
        event.targetId === "mcp-post-turn" && event.family === "relief"
      )), true);
      const linkedEvent = inspection.events.find((event: Record<string, any>) => (
        event.id === frustrationState.saved[0].eventId
      ));
      assert.equal(linkedEvent.memoryEntryId, frustrationState.saved[0].memoryEntryId);

      const mcpContextCall = await client.callTool({
        name: "character_context.get",
        arguments: {},
      });
      assert.equal(mcpContextCall.isError, undefined, JSON.stringify(mcpContextCall));
      const mcpContext = mcpContextCall.structuredContent as Record<string, any>;
      const cliContextOutput = outputBuffer();
      assert.equal(await runCli([
        "context-get",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
        }),
      ], { env: operatorCliEnv, stdout: cliContextOutput.stream, stderr: outputBuffer().stream }), 0);
      const cliContext = cliContextOutput.json();
      const lifecycleContext = await runtime.characterContextService.getContext({
        schemaVersion: "withmate-character-context-v1",
        characterId: "character-a",
        sessionId: "session-a",
      }, "lifecycle") as Record<string, any>;
      assert.deepEqual(cliContext.affect, mcpContext.affect);
      assert.deepEqual(lifecycleContext.affect, mcpContext.affect);
      assert.equal(mcpContext.affect.evaluatedAt, "2026-08-09T09:00:00.000Z");
      assert.equal(mcpContext.affect.effective.some((component: Record<string, any>) => (
        component.family === "frustration" && component.targetId === "mcp-integration"
      )), true);

      const appendOutput = outputBuffer();
      assert.equal(await runCli([
        "character-memory-append-episode",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
          authority: { kind: "operator", reason: "CLI integration write." },
          idempotencyKey: "cli-episode-1",
          episode: {
            title: "CLI and MCP shared state",
            body: "The integration test observed one shared runtime state.",
            preview: "CLI and MCP shared one state.",
            motif: "adapter-parity",
            observedFact: "The integration test completed the CLI write.",
          },
        }),
      ], { env: operatorCliEnv, stdout: appendOutput.stream, stderr: outputBuffer().stream }), 0);
      const appended = appendOutput.json();

      const correctOutput = outputBuffer();
      assert.equal(await runCli([
        "character-memory-correct",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          entryId: appended.entry.id,
          authority: { kind: "conversation" },
          reason: "Integration correction.",
          idempotencyKey: "cli-episode-correct-1",
          replacement: {
            title: "CLI correction visible from MCP",
            body: "The corrected integration state is shared with MCP.",
            preview: "CLI correction is visible from MCP.",
            motif: "adapter-parity",
            observedFact: "The CLI correction completed.",
          },
        }),
      ], { env: operatorCliEnv, stdout: correctOutput.stream, stderr: outputBuffer().stream }), 0);
      const corrected = correctOutput.json();

      const search = await client.callTool({
        name: "character_memory.search",
        arguments: {
          query: "CLI correction visible MCP",
          scope: { scope: "character" },
          limit: 5,
        },
      });
      assert.equal(search.isError, undefined);
      const searchResult = search.structuredContent as Record<string, any>;
      assert.equal(searchResult.items[0].id, corrected.entry.id);
      assert.equal(searchResult.items[0].scope.type, "character");

      const forgotten = await client.callTool({
        name: "character_memory.forget",
        arguments: {
          entryId: corrected.entry.id,
          reason: "user_request",
          idempotencyKey: "mcp-forget-1",
        },
      });
      assert.equal(forgotten.isError, undefined);
      assert.equal((forgotten.structuredContent as Record<string, any>).readBack, "forgotten");

      const failureDb = new DatabaseSync(runtime.dbPath);
      failureDb.exec("ALTER TABLE memory_entries_v6 RENAME TO memory_entries_v6_unavailable");
      failureDb.close();

      const failedCliSearchOutput = outputBuffer();
      assert.equal(await runCli([
        "character-memory-search",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          query: "server failure",
          scope: { scope: "character" },
          limit: 3,
        }),
      ], { env: operatorCliEnv, stdout: failedCliSearchOutput.stream, stderr: outputBuffer().stream }), 3);
      assert.equal(failedCliSearchOutput.json().error.code, "storage_unavailable");
      assert.equal(failedCliSearchOutput.json().error.effect, "none");

      const failedMcpSearch = await client.callTool({
        name: "character_memory.search",
        arguments: {
          query: "server failure",
          scope: { scope: "character" },
          limit: 3,
        },
      });
      assert.equal(failedMcpSearch.isError, true);
      assert.equal((failedMcpSearch.structuredContent as Record<string, any>).error.code, "storage_unavailable");
      assert.equal((failedMcpSearch.structuredContent as Record<string, any>).error.effect, "none");
    } finally {
      await client.close();
      await server.close();
      turns.end(turn);
      await runtime.stop();
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });
});
