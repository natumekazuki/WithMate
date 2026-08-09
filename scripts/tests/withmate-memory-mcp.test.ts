import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  CHARACTER_MCP_SERVER_INSTRUCTIONS,
  CHARACTER_MCP_TOOL_DEFINITIONS,
  createWithMateMemoryMcpServer,
} from "../withmate-memory-mcp.js";

describe("WithMate Memory / Character Affect MCP contract", () => {
  it("6 toolsをschema、短い利用条件、read/write annotation付きで公開する", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer();
    const client = new Client({ name: "withmate-mcp-contract-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.listTools();
      assert.deepEqual(
        result.tools.map((tool) => tool.name),
        CHARACTER_MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
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
        assert.equal(tool.annotations?.idempotentHint, true);
      }
      const appendEpisode = result.tools.find((tool) => tool.name === "character_memory.append_episode");
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
      assert.match(CHARACTER_MCP_SERVER_INSTRUCTIONS, /Character's own affect/);
      assert.match(CHARACTER_MCP_SERVER_INSTRUCTIONS, /raw conversation transcript/);
      assert.match(CHARACTER_MCP_SERVER_INSTRUCTIONS, /explicit user instruction/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("runtime unavailableをwrite成功にせず、retryabilityとconversation継続可否を返す", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateMemoryMcpServer({
      env: { WITHMATE_MEMORY_DISCOVERY_FILE: "Z:/missing/withmate-memory.json" },
    });
    const client = new Client({ name: "withmate-mcp-unavailable-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();
      const result = await client.callTool({
        name: "character_context.get",
        arguments: { characterId: "character-a", sessionId: "session-a" },
      });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        schemaVersion: "withmate-character-context-v1",
        error: {
          code: "storage_unavailable",
          message: "WithMate runtime is not available.",
          retryable: true,
          conversationMayContinue: true,
          effect: "none",
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

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
      fetch: async (url) => {
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
      },
    });
    const client = new Client({ name: "withmate-mcp-http-error-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "character_context.get",
        arguments: { characterId: "character-a", sessionId: "session-a" },
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
});
