import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  CHARACTER_MCP_SERVER_INSTRUCTIONS,
  CHARACTER_MCP_TOOL_DEFINITIONS,
  createWithMateMemoryMcpServer,
} from "../withmate-memory-mcp.js";
import {
  createWithMateMemoryRuntimeChallenge,
  WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_NONCE_HEADER,
} from "../../src/memory-v6/memory-runtime-exchange.js";
import {
  verifyRuntimeIdentity,
  WithMateMemoryRuntimeExchangeError,
  WITHMATE_MEMORY_API_SECRET_HEADER,
  type WithMateMemoryRuntimeConnection,
  type WithMateMemoryRuntimeOperation,
  type WithMateMemoryRuntimeResponse,
} from "../withmate-memory-runtime-client.js";

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
        arguments: { characterId: "character-a", sessionId: "session-a" },
      });
      const writeResult = await client.callTool({
        name: "character_memory.forget",
        arguments: {
          characterId: "character-a",
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
          characterId: "character-a",
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
        arguments: { characterId: "character-a", sessionId: "session-a" },
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
      },
    });
    const client = new Client({ name: "withmate-mcp-peer-swap-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "character_memory.forget",
        arguments: {
          characterId: "character-a",
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
      assert.equal((result.structuredContent as any).error.effect, "unknown");
      assert.equal(replacementRequests, 0);
      assert.equal(firstHeaders.length, 1);
      assert.equal(firstHeaders[0]["x-withmate-memory-api-secret"], undefined);
      assert.equal(firstHeaders[0]["x-withmate-memory-mcp-api-secret"], undefined);
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
