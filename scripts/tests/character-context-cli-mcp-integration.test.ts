import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  it("MCP writeとCLI inspect/searchが同じstate、scope、versionをread-backする", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-character-runtime-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-character-discovery-"));
    const runtime = await startMemoryV6RuntimeApi({
      userDataPath,
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

    const cliEnv = { WITHMATE_MEMORY_DISCOVERY_FILE: runtime.discoveryFilePath };
    const mcpEnv = { WITHMATE_MEMORY_DISCOVERY_FILE: runtime.mcpDiscoveryFilePath };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({ env: mcpEnv });
    const client = new Client({ name: "withmate-cli-mcp-integration", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const beforeOutput = outputBuffer();
      assert.equal(await runWithMateMemoryCli([
        "context-get",
        "--fallback-from",
        "mcp",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
        }),
      ], { env: cliEnv, stdout: beforeOutput.stream, stderr: outputBuffer().stream }), 0);
      const before = beforeOutput.json();

      const metricsOutput = outputBuffer();
      assert.equal(await runWithMateMemoryCli([
        "character-metrics",
      ], { env: cliEnv, stdout: metricsOutput.stream, stderr: outputBuffer().stream }), 0);
      assert.equal(metricsOutput.json().metrics.fallbacks["mcp->cli"], 1);

      const rejectedCliOutput = outputBuffer();
      assert.equal(await runWithMateMemoryCli([
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
      ], { env: cliEnv, stdout: rejectedCliOutput.stream, stderr: outputBuffer().stream }), 0);
      assert.equal(rejectedCliOutput.json().saved.length, 0);
      assert.equal(rejectedCliOutput.json().rejected[0].code, "invalid_input");

      const appraisal = await client.callTool({
        name: "character_affect.appraise",
        arguments: {
          characterId: "character-a",
          sessionId: "session-a",
          expectedVersion: before.affect.version,
          candidates: [{
            schemaVersion: "withmate-affect-v1",
            characterId: "character-a",
            userId: "local-user",
            sessionId: "session-a",
            layer: "session",
            targetType: "task",
            targetId: "mcp-integration",
            family: "interest",
            value: { label: "interest", valence: 0.5 },
            intensity: 0.7,
            reason: "The integration became observable.",
            evidence: "MCP and CLI used one runtime.",
            occurredAt: "2026-08-09T03:00:00.000Z",
            idempotencyKey: "mcp-affect-1",
          }],
        },
      });
      assert.equal(appraisal.isError, undefined, JSON.stringify(appraisal));
      const appraisalState = appraisal.structuredContent as Record<string, any>;

      const inspectOutput = outputBuffer();
      assert.equal(await runWithMateMemoryCli([
        "affect-inspect",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
          authority: { kind: "operator", reason: "Integration inspection." },
        }),
      ], { env: cliEnv, stdout: inspectOutput.stream, stderr: outputBuffer().stream }), 0);
      const inspection = inspectOutput.json();
      assert.equal(inspection.version.version, appraisalState.version);
      assert.equal(inspection.events[0].targetId, "mcp-integration");
      assert.equal(inspection.events[0].family, "interest");

      const mcpContextCall = await client.callTool({
        name: "character_context.get",
        arguments: { characterId: "character-a", sessionId: "session-a" },
      });
      assert.equal(mcpContextCall.isError, undefined, JSON.stringify(mcpContextCall));
      const mcpContext = mcpContextCall.structuredContent as Record<string, any>;
      const cliContextOutput = outputBuffer();
      assert.equal(await runWithMateMemoryCli([
        "context-get",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
        }),
      ], { env: cliEnv, stdout: cliContextOutput.stream, stderr: outputBuffer().stream }), 0);
      const cliContext = cliContextOutput.json();
      const lifecycleContext = await runtime.characterContextService.getContext({
        schemaVersion: "withmate-character-context-v1",
        characterId: "character-a",
        sessionId: "session-a",
      }, "lifecycle") as Record<string, any>;
      assert.deepEqual(cliContext.affect, mcpContext.affect);
      assert.deepEqual(lifecycleContext.affect, mcpContext.affect);
      assert.equal(mcpContext.affect.evaluatedAt, "2026-08-09T09:00:00.000Z");
      assert.equal(mcpContext.affect.effective[0].family, "interest");
      assert.equal(mcpContext.affect.effective[0].intensity, 0.35);

      const appendOutput = outputBuffer();
      assert.equal(await runWithMateMemoryCli([
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
      ], { env: cliEnv, stdout: appendOutput.stream, stderr: outputBuffer().stream }), 0);
      const appended = appendOutput.json();

      const correctOutput = outputBuffer();
      assert.equal(await runWithMateMemoryCli([
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
      ], { env: cliEnv, stdout: correctOutput.stream, stderr: outputBuffer().stream }), 0);
      const corrected = correctOutput.json();

      const search = await client.callTool({
        name: "character_memory.search",
        arguments: {
          characterId: "character-a",
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
          characterId: "character-a",
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
      assert.equal(await runWithMateMemoryCli([
        "character-memory-search",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          query: "server failure",
          scope: { scope: "character" },
          limit: 3,
        }),
      ], { env: cliEnv, stdout: failedCliSearchOutput.stream, stderr: outputBuffer().stream }), 3);
      assert.equal(failedCliSearchOutput.json().error.code, "storage_unavailable");
      assert.equal(failedCliSearchOutput.json().error.effect, "none");

      const failedMcpSearch = await client.callTool({
        name: "character_memory.search",
        arguments: {
          characterId: "character-a",
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
      await runtime.stop();
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });
});
