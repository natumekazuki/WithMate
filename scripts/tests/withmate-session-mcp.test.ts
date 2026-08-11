import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  SESSION_MCP_TOOL_DEFINITIONS,
  createWithMateSessionMcpServer,
} from "../withmate-session-mcp.js";
import { SessionRuntimeClientError, type SessionRuntimeConnection } from "../withmate-session-runtime-client.js";
import {
  SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
  SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  createSessionRuntimeResult,
} from "../../src/session-external-runtime-contract.js";

const connection: SessionRuntimeConnection = {
  adapter: "mcp",
  baseUrl: "http://127.0.0.1:1",
  apiSecret: "api-secret",
  adapterSecret: "mcp-secret",
  runtimeInstanceId: "runtime-1",
};

const executionInput = { sessionId: "session-1", executionId: "execution-1" };
const cancelInput = { ...executionInput, idempotencyKey: "cancel-key-1" };

async function withClient<T>(
  server: ReturnType<typeof createWithMateSessionMcpServer>,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "withmate-session-mcp-test", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("WithMate Session MCP contract", () => {
  it("5 toolsをdotted name、strict schema、read/write annotation付きで公開する", async () => {
    await withClient(createWithMateSessionMcpServer(), async (client) => {
      const result = await client.listTools();
      assert.deepEqual(result.tools.map((tool) => tool.name), SESSION_MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
      for (const tool of result.tools) {
        assert.equal(tool.inputSchema.type, "object");
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.equal(tool.outputSchema?.type, "object");
        assert.ok(tool.description?.trim());
        assert.equal(tool.annotations?.openWorldHint, false);
        assert.equal(tool.annotations?.idempotentHint, true);
      }
      assert.equal(result.tools.find((tool) => tool.name === "turn.list")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "turn.cancel")?.annotations?.destructiveHint, true);
    });
  });

  it("MCP専用adapterでdiscoveryし、public resultをstructuredContentへ返す", async () => {
    let adapter = "";
    await withClient(createWithMateSessionMcpServer({
      discover: async (options) => {
        adapter = options.adapter ?? "";
        return connection;
      },
      call: async (_connection, envelope) => ({
        ok: true,
        status: 200,
        value: createSessionRuntimeResult(envelope.operation, { execution: { id: "execution-1", state: "completed" } }),
      }),
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(adapter, "mcp");
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
        operation: "turn.get",
        result: { execution: { id: "execution-1", state: "completed" } },
      });
    });
  });

  it("空白のみの識別子をprotocol validationで拒否してruntimeを呼ばない", async () => {
    let runtimeCalls = 0;
    await withClient(createWithMateSessionMcpServer({
      discover: async () => {
        runtimeCalls += 1;
        return connection;
      },
    }), async (client) => {
      const result = await client.callTool({
        name: "turn.get",
        arguments: { sessionId: "   ", executionId: "execution-1" },
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(runtimeCalls, 0);
    });
  });

  it("application errorをversioned structured tool errorへ写像する", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => ({
        ok: false,
        status: 409,
        value: createSessionRuntimeError({ code: "SESSION_BUSY", message: "Session is busy." }),
      }),
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        schemaVersion: SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
        error: {
          code: "SESSION_BUSY",
          message: "Session is busy.",
          retryable: false,
          effect: "not_applied",
          details: {},
        },
      });
    });
  });

  it("terminal failed executionをtool successとして返す", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => ({
        ok: true,
        status: 200,
        value: createSessionRuntimeResult("turn.get", {
          execution: { id: "execution-1", state: "failed", errorCode: "PROVIDER_FAILURE" },
        }),
      }),
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as any).result.execution.state, "failed");
    });
  });

  it("pre-dispatch failureはnot_applied、mutationのpost-dispatch failureはindeterminateにする", async () => {
    for (const [dispatched, expectedEffect] of [[false, "not_applied"], [true, "indeterminate"]] as const) {
      await withClient(createWithMateSessionMcpServer({
        discover: async () => connection,
        call: async () => { throw new SessionRuntimeClientError("private C:\\secret stack", dispatched); },
      }), async (client) => {
        const result = await client.callTool({ name: "turn.cancel", arguments: cancelInput });
        assert.equal(result.isError, true);
        assert.equal((result.structuredContent as any).error.effect, expectedEffect);
        assert.doesNotMatch(JSON.stringify(result.structuredContent), /secret|stack/i);
      });
    }
  });

  it("read operationのpost-dispatch failureはnot_appliedにする", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => { throw new SessionRuntimeClientError("response lost", true); },
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal((result.structuredContent as any).error.effect, "not_applied");
    });
  });

  it("CLI-INPUT-LIMIT-01: shared request limit failureはCONTENT_TOO_LARGE/not_appliedを返す", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => {
        throw new SessionRuntimeValidationError(
          "Session runtime request body exceeds 8 MiB.",
          { maxBytes: 8 * 1024 * 1024 },
          "CONTENT_TOO_LARGE",
        );
      },
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as any).error.code, "CONTENT_TOO_LARGE");
      assert.equal((result.structuredContent as any).error.effect, "not_applied");
    });
  });

  it("identity mismatchではoperation requestをdispatchしない", async () => {
    let operationBodyBytes = 0;
    const runtime = createServer((request, response) => {
      request.on("data", (chunk) => { operationBodyBytes += Buffer.byteLength(chunk); });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ runtimeInstanceId: "different-runtime", challenge: {} }));
    });
    await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
    const port = (runtime.address() as AddressInfo).port;
    try {
      await withClient(createWithMateSessionMcpServer({
        discover: async () => ({ ...connection, baseUrl: `http://127.0.0.1:${port}` }),
      }), async (client) => {
        const result = await client.callTool({ name: "turn.cancel", arguments: cancelInput });
        assert.equal(result.isError, true);
        assert.equal((result.structuredContent as any).error.effect, "not_applied");
        assert.equal(operationBodyBytes, 0);
      });
    } finally {
      await new Promise<void>((resolve) => runtime.close(() => resolve()));
    }
  });
});
